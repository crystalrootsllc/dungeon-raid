import { isAddress, parseAbi, parseAbiItem, zeroAddress, type Address, type PublicClient } from "viem";
import { GENERATION_SPRITE_MANIFEST } from "./generation-sprites.js";
import type { GenerationDeployment } from "./identity.js";

export type OwnedFriendsClient = Pick<PublicClient, "getLogs" | "readContract" | "getBlockNumber" | "getChainId">;
export type OwnedFriend = Readonly<{
  id: bigint; label: string; kind: "owned"; walletAddress: Address; generation: number;
}>;
export type OwnedFriendsOptions = Readonly<{
  deployment?: GenerationDeployment;
  signal?: AbortSignal;
  /** First block of owner-filtered history. Defaults to the canonical Generations deployment block. */
  fromBlock?: bigint;
  /** Largest block span per eth_getLogs request. Defaults to OWNED_FRIENDS_LOG_RANGE. */
  maxBlockRange?: bigint;
}>;

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function generation(uint256 tokenId) view returns (uint8)",
  "function tokenBoundAccount(uint256 tokenId) view returns (address)",
]);
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const validAddress = (value: unknown): value is Address => typeof value === "string" && isAddress(value) && !equal(value, zeroAddress);
const validId = (value: unknown): value is bigint => typeof value === "bigint" && value > 0n && value < 1n << 256n;
const MAX_TRANSFER_LOGS = 100_000;
const MAX_OWNED_FRIENDS = 10_000;
/**
 * Creation block of the canonical Generations contract on Robinhood mainnet
 * (tx 0xa662cf05f02bdfcbdf60ed8218c22c46685ca336a63b902f0a79ea22b435d3d9). No
 * Transfer can precede it, so history starting here is complete.
 */
export const GENERATIONS_DEPLOYMENT_BLOCK = 63_100_099n;
/** The public Robinhood RPC rejects eth_getLogs spans over 10,000,000 blocks. */
export const OWNED_FRIENDS_LOG_RANGE = 5_000_000n;
const MIN_LOG_RANGE = 10_000n;
const RATE_LIMIT_RETRIES = 5;
/** Pause between log requests; the public RPC allows only short bursts of eth_getLogs. */
const LOG_REQUEST_SPACING_MS = 350;

function errorText(error: unknown): { text: string; codes: unknown[] } {
  const parts: string[] = [], codes: unknown[] = [];
  for (let e: any = error, depth = 0; e && depth < 8; e = e.cause, depth++) {
    for (const key of ["shortMessage", "details", "message"]) if (typeof e[key] === "string") parts.push(e[key]);
    codes.push(e.code, e.status);
  }
  return { text: parts.join(" | "), codes };
}
// The public RPC's 429 responses carry an invalid "Access-Control-Allow-Origin: *,*"
// header, so browsers surface rate limits as opaque network failures. Treat both as retryable.
const rateLimited = (error: unknown) => {
  const { text, codes } = errorText(error);
  return codes.includes(429) || codes.includes(-32005) ||
    /too many requests|rate.?limit|failed to fetch|load failed|networkerror|network request failed|access control|cors/i.test(text);
};
const rangeRefused = (error: unknown) =>
  /narrow the block range|block range|range too (wide|large)|query spans|timed out|timeout|exceeds limit|more than \d+ (results|logs)|too many (results|logs)/i.test(errorText(error).text);
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
  function stop() { clearTimeout(timer); reject(signal!.reason); }
  signal?.addEventListener("abort", stop, { once: true });
});

/**
 * Read-only discovery using indexed, owner-filtered Transfer queries (split into
 * bounded block windows from the Generations deployment block). The
 * canonical Generations contract has no ERC721Enumerable owner enumeration.
 * Only currently held IDs are read; totalMinted and global token scans are never
 * used. Providers must support the filtered history query without truncation.
 * Failures remain errors, never an empty/ineligible result or a scan fallback.
 *
 * This selection snapshot is not lasting authorization. The trusted wrapper
 * must freshly call readGenerationEligibility before enabling the selected game.
 */
export async function readOwnedFriends(
  client: OwnedFriendsClient, account: Address, options: OwnedFriendsOptions = {},
): Promise<Readonly<{ friends: readonly OwnedFriend[]; blockNumber: bigint; hiddenCount: number }>> {
  const deployment = options.deployment ?? GENERATION_SPRITE_MANIFEST;
  if (!validAddress(account)) throw new TypeError("Owned Friend discovery requires a nonzero connected account.");
  if (!validAddress(deployment.generations) || !Number.isSafeInteger(deployment.chainId) || deployment.chainId < 1) {
    throw new TypeError("Invalid Generations deployment.");
  }
  const active = () => options.signal?.throwIfAborted();
  async function checkChain() {
    active();
    if (await client.getChainId() !== deployment.chainId) throw new Error(`Friend discovery requires chain ${deployment.chainId}.`);
    active();
  }
  await checkChain();
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  active();
  const balance = await client.readContract({ address: deployment.generations, abi: ABI,
    functionName: "balanceOf", args: [account], blockNumber });
  active();
  if (typeof balance !== "bigint" || balance < 0n || balance > BigInt(MAX_OWNED_FRIENDS)) {
    throw new Error(`Friend discovery supports up to ${MAX_OWNED_FRIENDS} NFTs per connected account.`);
  }
  if (balance === 0n) {
    await checkChain();
    return Object.freeze({ friends: Object.freeze([]), blockNumber, hiddenCount: 0 });
  }

  const canonical = deployment.chainId === GENERATION_SPRITE_MANIFEST.chainId && equal(deployment.generations, GENERATION_SPRITE_MANIFEST.generations);
  // The deployment hint applies only to a chain that has reached it (never to a local fixture or fork).
  const fromBlock = options.fromBlock ?? (canonical && GENERATIONS_DEPLOYMENT_BLOCK <= blockNumber ? GENERATIONS_DEPLOYMENT_BLOCK : 0n);
  const maxRange = options.maxBlockRange ?? OWNED_FRIENDS_LOG_RANGE;
  if (typeof fromBlock !== "bigint" || fromBlock < 0n || fromBlock > blockNumber || typeof maxRange !== "bigint" || maxRange < 1n) {
    throw new RangeError("Invalid Friend discovery block range.");
  }
  type TransferLog = Awaited<ReturnType<typeof readWindow>>[number];
  let total = 0, requests = 0;
  function readWindow(start: bigint, end: bigint, args: { to: Address } | { from: Address }) {
    return client.getLogs({ address: deployment.generations, event: TRANSFER, fromBlock: start, toBlock: end, args, strict: true });
  }
  // Owner-filtered history in bounded, contiguous windows. A window the RPC refuses
  // as too wide or too slow is halved; rate limits back off. Nothing unfiltered is read.
  async function history(args: { to: Address } | { from: Address }) {
    const logs: TransferLog[] = [];
    let start = fromBlock, span = maxRange, retries = 0;
    while (start <= blockNumber) {
      active();
      if (requests++) await wait(LOG_REQUEST_SPACING_MS, options.signal);
      const end = start + span - 1n < blockNumber ? start + span - 1n : blockNumber;
      let window: TransferLog[];
      try {
        window = await readWindow(start, end, args);
      } catch (error) {
        active();
        if (rateLimited(error) && retries < RATE_LIMIT_RETRIES) { await wait(750 * 2 ** retries++, options.signal); continue; }
        const size = end - start + 1n;
        if (rangeRefused(error) && size > MIN_LOG_RANGE) { span = size / 2n > MIN_LOG_RANGE ? size / 2n : MIN_LOG_RANGE; continue; }
        throw error;
      }
      for (const log of window) {
        if (log.blockNumber === null || log.blockNumber < start || log.blockNumber > end) {
          throw new Error("RPC returned invalid owner-filtered Friend transfer history. Retry discovery.");
        }
      }
      total += window.length;
      if (total > MAX_TRANSFER_LOGS) {
        throw new Error("This account's Friend transfer history exceeds the discovery limit; use an indexed account provider.");
      }
      logs.push(...window);
      start = end + 1n; retries = 0;
    }
    return logs;
  }
  // Sequential, not parallel, to stay within the public RPC's burst limit.
  const [received, sent] = await (async () => [await history({ to: account }), await history({ from: account })] as const)().catch(cause => {
    active();
    if (cause instanceof Error && /discovery limit|invalid owner-filtered/.test(cause.message)) throw cause;
    throw new Error("Could not load this account's Friend transfers. Retry with an RPC that supports owner-filtered history; the SDK will not scan the collection.", { cause });
  });
  active();
  // A transfer to self appears in both queries. Deduplicate by its chain position.
  const events = new Map<string, typeof received[number]>();
  for (const log of [...received, ...sent]) {
    const { from, to, tokenId } = log.args;
    if (!equal(log.address, deployment.generations) || log.removed ||
        log.blockNumber === null || log.blockNumber < 0n || log.blockNumber > blockNumber ||
        log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 ||
        !isAddress(from) || !isAddress(to) || !validId(tokenId) ||
        (!equal(from, account) && !equal(to, account))) {
      throw new Error("RPC returned invalid owner-filtered Friend transfer history. Retry discovery.");
    }
    const key = `${log.blockNumber}:${log.logIndex}`;
    const previous = events.get(key);
    if (previous && (previous.args.tokenId !== tokenId || !equal(previous.args.from, from) || !equal(previous.args.to, to))) {
      throw new Error("RPC returned conflicting Friend transfer history. Retry discovery.");
    }
    events.set(key, log);
  }
  const ordered = [...events.values()].sort((a, b) =>
    a.blockNumber! === b.blockNumber! ? a.logIndex! - b.logIndex! : a.blockNumber! < b.blockNumber! ? -1 : 1);
  const held = new Set<bigint>();
  for (const log of ordered) {
    if (equal(log.args.to, account)) held.add(log.args.tokenId);
    else held.delete(log.args.tokenId);
  }
  if (BigInt(held.size) !== balance) {
    throw new Error("Friend transfer history is incomplete or changed. Retry with a complete owner-filtered RPC history.");
  }

  const ids = [...held].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const friends: OwnedFriend[] = [];
  // Bound concurrent RPC reads even for accounts with many owned NFTs.
  for (let offset = 0; offset < ids.length; offset += 8) {
    active();
    const group = await Promise.all(ids.slice(offset, offset + 8).map(async id => {
      const [owner, generation] = await Promise.all([
        client.readContract({ address: deployment.generations, abi: ABI, functionName: "ownerOf", args: [id], blockNumber }),
        client.readContract({ address: deployment.generations, abi: ABI, functionName: "generation", args: [id], blockNumber }),
      ]);
      active();
      if (!validAddress(owner) || !equal(owner, account)) throw new Error("Friend ownership changed or transfer history is inconsistent. Retry discovery.");
      if (!Number.isInteger(generation) || generation < 0 || generation > 255) throw new Error("RPC returned an invalid Friend generation.");
      if (generation < 1) return null;
      const walletAddress = await client.readContract({ address: deployment.generations, abi: ABI,
        functionName: "tokenBoundAccount", args: [id], blockNumber });
      active();
      if (!validAddress(walletAddress)) throw new Error("Generations returned an invalid canonical Friend wallet.");
      return Object.freeze({ id, label: `Friend #${id}`, kind: "owned" as const, walletAddress, generation });
    }));
    friends.push(...group.filter(friend => friend !== null));
  }
  await checkChain();
  return Object.freeze({ friends: Object.freeze(friends), blockNumber, hiddenCount: ids.length - friends.length });
}
