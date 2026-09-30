# Dungeon Raid

**Judge summary**
1. **Concept (Character Spotlight):** Your Generations NFT is the playable hero — original FriendSDK art — raiding a pixel dungeon vs Shade Moth.
2. **Controls:** Attack on OPEN, Guard when the ring turns lime (INCOMING), Rare Beam (5x) after 2 timed guards.
3. **Normal / Max:** 2 bars vs 4 bars (faster, double strikes); Max may buy an optional simulated Shield Bar.
4. **Wallet:** Robinhood mainnet **4663** + hardwired Generations NFT **gen ≥ 1**. FriendSDK runtime owns wallet + Friend pick.
5. **SDK:** FriendSDK **v0.1.2**. Folder id `familiar-care`. Economy is simulated and labeled.

SDK version **v0.1.2**. Rare Friends Vibeathon raid. Folder id stays
`familiar-care`; the product name is **Dungeon Raid** (formerly Nest Raid).

Your selected Rare Friends **Generations** Friend (FriendSDK sprites) duels
**Shade Moth**, a big telegraphing boss, in a pixel-art dungeon. No custom wallet UI: the FriendSDK
runtime supplies wallet connection, owned Friend selection and the fresh
eligibility check (Robinhood mainnet 4663, Generations NFT with generation >= 1).
Automated tests use the SDK mock wallet fixture only. No emoji anywhere in the UI.

## Boss art

Shade Moth is chunky pixel art on a 48x32 grid (left half mirrored), drawn
nearest-neighbor with whole-device-pixel cells and a #111 ink outline, in the RF
palette: lilac wings, ink body, sun eyespots, coral accents, lime weak point.
States: idle (2-frame flap), OPEN (lime core + blinking pixel halo), INCOMING
(wings raised, coral eyes, jitter, coral sparks), hit flash (white fill, ink
outline kept) and defeat (drooped wings, eyes out). The guard ring, strike line
and block arc are drawn as pixel squares matching the Friend sprite's pixel size.

## Dungeon and juice

- The arena is a pixel dungeon drawn at the moth's own cell size: stone brick
  wall in muted grays, a dark arched doorway behind the boss, two wall torches
  with a 2-frame pixel flicker and stepped, dithered sun (#F2CE68) light, and a
  flagstone floor. Lime (#CCFF00) is reserved for gameplay cues.
- Title screen: DUNGEON RAID wordmark in a 5x7 pixel font over the dungeon, a
  large idle Shade Moth, Normal / Max start buttons, the optional Shield Bar,
  a 3-line How to play, Leaderboard, Rules and Settings.
- Hit-stop on Rare Beam, bar breaks and the killing blow; pixel-snapped screen
  shake on boss hits and when your Friend takes damage; damage numbers in the
  pixel font; a stepped flash plus BAR BROKEN callout and a HUD flash when a boss
  HP bar empties.
- The killing blow swaps the OPEN / INCOMING banner for VICTORY (or DEFEATED)
  on that frame and locks the buttons; the end screen follows about 1.3 s later
  with a score breakdown (time, timed guards, damage taken, difficulty
  multiplier) and Play again / Leaderboard / Title.
- Reduced motion turns off shake, flicker and flashes.

## Combat

The moth alternates two telegraphs:

- **OPEN** (lime banner, lime ring on the moth): attack window.
- **INCOMING** (coral banner): a strike is coming. A coral ring closes on your
  Friend and turns lime at the end (**GUARD NOW**). That is the timed-guard window
  (0.40 s on Normal, 0.32 s on Max).

Three buttons only:

| Button | Keys | Effect |
| --- | --- | --- |
| **Attack** | A / 1 | 7 damage on OPEN. On INCOMING you are punished (counter damage to you, 1 to the moth). |
| **Guard** | G / 2 / Space | Timed guard (in the lime window): blocks fully and charges Rare Beam +1. Early guard: "Guarded too early", blocks half, no charge. After the strike: "Too late", no charge. |
| **Rare Beam** | R / 3 | Special attack. **Locked** until 2 timed guards, then lit lime (#CCFF00). 35 damage (5x Attack) on OPEN; wasted (7 damage) on INCOMING. |

Your Friend has 100 HP; at 0 HP the raid is lost. Breaking a boss bar staggers
the moth (extra OPEN time).

## Difficulty

| | Boss | Tempo | Score multiplier |
| --- | --- | --- | --- |
| **Normal** | 2 HP bars (Bar 1/2, Bar 2/2), 165 each | open 2.0 s, wind-up 1.35 s, hit 20 | x1 |
| **Max** | 4 HP bars, 165 each | open 1.45 s, wind-up 1.0 s (faster each bar), double strikes from bar 2, hit 26 | x2.5 |

Bar HP is tuned so a perfect run (every timed guard, Rare Beam on every OPEN it
is ready for) takes about 20 s on Normal and about 35 s on Max.

Before a Max fight you may buy **one Shield Bar**: an extra 100 HP bar layered
over your HP that absorbs damage first, for that one Max fight. Max is winnable
without it (four unguarded hits end the run), just much harder.

## Economy (SIMULATED)

All economy actions stay simulated through the SDK's fixed action client
(`buy` / `play` / `settle` / `redeem`) and its runtime confirmations; no
transactions are sent in preview.

- Consumable: **Shield Bar**, price **5 RF** (`5000000000000000000` base units).
  "Buy Shield Bar" calls `client.buy(1n)` (runtime confirmation shows the price),
  then `client.play(1n)` + `client.settle()` to use it (second confirmation:
  "Use shield bar"). The shield is then armed for the next Max fight.
- The SDK chance-game schema requires at least one positive prize, so a used
  Shield Bar always (10000 bps) leaves one **Moth Scale**, redeemable for **1 RF**
  (`client.redeem`). Expected and maximum reward: 1 RF. Net shield cost: 4 RF.
- Preview Friends start with 20 simulated RF, which is enough for several shields.

## Leaderboard

Clears only. Score = (5000 + time bonus (6000 minus 100 per second, floor 0)
+ 250 per timed guard - 15 per HP lost (shield included)) x difficulty
multiplier. Separate Normal and Max tabs show rank, Friend #, score, time,
damage, timed guards and a Shield tag.

FriendSDK v0.1.2 has no storage or leaderboard API, and the opaque sandbox
blocks `localStorage`. The board tries `localStorage` and falls back to memory.
It is labelled **LOCAL**, and says "session only" when storage is blocked,
which is always the case inside the SDK frame. Nothing is seeded and no other
players are shown.

## Layout

- The trusted `host.css` moves the SDK toolbar (Local preview / Friend / Friend
  wallet) into its own strip below the game, so it can never cover the combat
  buttons. On phones (width <= 600 px or height <= 560 px) the frame fills the
  screen height instead of a 3:2 letterbox.
- Checked at 960x800, 390x844 and 390x659 (iPhone Safari visible area):
  no overlap, no scrolling on title, fight, victory and leaderboard screens.
- Favicon: `public/favicon.ico` (16/32/48) and `public/apple-touch-icon.png`, a
  pixel Shade Moth on stone. The SDK build only emits its generated files, so
  copy `public/*` next to `index.html` when deploying.
- Mute and reduced-motion toggles; runtime `paused` and menus freeze the fight.

## Run locally

From the FriendSDK checkout (Node.js 22+):

```sh
cd friendsdk
npm ci
npm run build
npx friendsdk check games/familiar-care
npx friendsdk test --screenshot /tmp/dungeon-raid-960.png games/familiar-care
npx friendsdk test --width 390 --screenshot /tmp/dungeon-raid-390.png games/familiar-care
npx friendsdk build games/familiar-care
npm run dev:game -- games/familiar-care
```

Static preview: serve `games/familiar-care/.friendsdk/` (entry `index.html`) from
any HTTPS static host.
