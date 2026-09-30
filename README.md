# Dungeon Raid

Rare Friends Vibeathon entry (Character Spotlight). FriendSDK **v0.1.2** game folder (`familiar-care`).

Your Generations Friend raids a pixel dungeon and fights **Shade Moth**: Attack on OPEN, timed Guard on INCOMING, Rare Beam after 2 timed guards. Normal (2 bars) or Max (4 bars, optional simulated Shield Bar).

## Play

- Live tunnel preview: https://forty-wed-truly-cancelled.trycloudflare.com
- GitHub Pages (if enabled): https://crystalrootsllc.github.io/dungeon-raid-preview/

## Run locally (Node.js 22+)

Place this folder at `games/familiar-care` inside a [FriendSDK v0.1.2](https://github.com/spokesz/friendsdk) checkout, then:

```sh
# Recommended: apply the owned-friends RPC patch (public Robinhood RPC block-range limit)
cp patches/owned-friends.ts /path/to/friendsdk/src/owned-friends.ts
cd /path/to/friendsdk && npm ci && npm run build
npx friendsdk check games/familiar-care
npx friendsdk build games/familiar-care
npm run dev:game -- games/familiar-care
```

Wallet: Robinhood mainnet **4663** + hardwired Generations NFT **gen ≥ 1**. Economy is **simulated**.

## Patch note

Stock FriendSDK 0.1.2 Friend discovery can fail on `rpc.mainnet.chain.robinhood.com` (eth_getLogs span limit). `patches/owned-friends.ts` chunks owner-filtered history from the Generations deploy block. Copy over `src/owned-friends.ts` and rebuild.

## License

Game code for this submission. FriendSDK is Apache-2.0 (see upstream). SDK artwork per FriendSDK NOTICE.
