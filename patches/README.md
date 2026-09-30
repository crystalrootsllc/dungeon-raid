# FriendSDK owned-friends patch (required for public Robinhood RPC)

Replace `src/owned-friends.ts` in FriendSDK v0.1.2 with `owned-friends.ts` from this folder, then `npm run build`.

Why: stock discovery issues one `eth_getLogs` from block 0 → head. Robinhood public RPC rejects spans over 10,000,000 blocks, so Choose your Friend fails with the owner-filtered history error. This patch starts at the Generations deployment block and chunks windows, with rate-limit backoff. It still never scans the collection.
