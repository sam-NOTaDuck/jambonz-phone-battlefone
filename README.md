# BattleFone

A Jambonz WebSocket voice application. A caller dials a phone number and plays a
Battleship-style game against the app's AI using the telephone keypad. The keypad
**is** the board: digits `0`-`9` are the 10 cells. The app is the moderator and the
opponent — it announces the game, narrates every shot, enforces the rules, plays the
AI, remembers the caller's fleet preferences, and cleans up when the caller hangs up.

This is a **v1 single-player vs the AI** app. There is no conference/room verb, no
speech recognition, and no LLM. All interaction is DTMF (`gather({ input: ['digits'] })`)
plus TTS (`say()`).

## Requirements

- Node.js 18+
- npm

## Install and run

```bash
npm install
npm run build   # tsc -> ./dist (must pass with zero errors)
npm start       # tsx src/app.ts, WebSocket endpoint on port 3011
```

You should see:

```
BattleFone listening on port 3011
```

A plain `GET /` returns `405 Method Not Allowed` (normal for a WebSocket jambonz
app). `OPTIONS /` returns `{}` so the jambonz portal can discover the (empty)
application environment-variable schema.

Runtime state lives under `./data/`:

- `data/caller-prefs.db` — SQLite caller-preference store (created on first use)
- `data/audio/` — optional audio clips (see Audio below)

## Provisioning a Jambonz app

1. In the jambonz portal, create a WebSocket application and point it at this
   server, e.g. `wss://your-host.example.com:3011/`.
2. Configure Google TTS at the application level. BattleFone deliberately does
   **not** call `.config({ synthesizer: ... })` and does not pass a `synthesizer`
   in any `say()` — it relies entirely on the portal application TTS.
3. No recognizer is needed (DTMF only), so leave STT unconfigured.
4. No application environment variables are required; the app declares
   `envVars: {}`.

The WebSocket path is `/` (the `makeService({ path: '/' })` route). If you run this
behind a TLS terminator/reverse proxy, terminate TLS in front of it and point the
portal at your public `wss://` URL; the app itself binds plain HTTP/WS on 3011.

## Keypad board map

```
1 2 3
4 5 6
7 8 9
  0
```

The 10 cells are the digits `0`-`9`. Neighbors share an edge:

- Horizontal: `1-2, 2-3, 4-5, 5-6, 7-8, 8-9`
- Vertical: `1-4, 2-5, 3-6, 4-7, 5-8, 6-9, 8-0`
- `0` is adjacent **only** to `8`

A 2-cell ship occupies exactly two adjacent cells (for example `[0, 8]`). Ships
never overlap. The keypad maps 1:1 to the board — there is no translation layer.

## Gameplay

1. **Welcome.** "Welcome to BattleFone. Press 1 for instant action, or 5 for
   options."
   - `1` = Instant Action: use the caller's remembered preferences (or defaults),
     auto-place both fleets, and start immediately.
   - `5` = Options: configure the fleet.
2. **Options.**
   - "How many ships? Press 1, 2, or 3." (default 2; max 3)
   - "Ship sizes. Press 1 for all one-cell ships. Press 2 for one two-cell ship and
     the rest one-cell. Press 3 for random sizes." (random picks each ship's size
     1 or 2 per game)
   - The choices are saved to the prefs DB under `game='battlefone'`
     (`ship_count`, `two_cell_count`), then "Fleet saved." is spoken and the game
     starts with the new fleet.
3. **Game setup (auto-place only in v1).** The caller's and the AI's fleets are
   placed independently and randomly. The caller always fires first:
   "Your fleet is set. Enemy fleet: N ships. Fire when ready. Your turn. Target a
   cell: zero through nine."
4. **Shoot loop.** Caller enters a digit `0`-`9`; the app echoes the shot and the
   result (miss/hit/sink) and the remaining enemy fleet count. Then the AI fires
   using a hunt/target strategy. Already-fired cells are rejected and re-gathered
   without an AI turn. Win = sink all enemy ships; lose = your fleet is sunk.
5. **After win/lose.** "Press star to play again. Press pound for the main menu."
   `*` starts a new game with the same fleet (fresh random boards); `#` returns to
   the main menu; timeout says goodbye and hangs up.

### Default fleet

`ship_count = 2`, `two_cell_count = 1` — one 2-cell ship plus one 1-cell ship. A
single-ship fleet with composition 2 (one two-cell ship "and the rest") is invalid,
so it falls back to one 2-cell ship.

### AI hunt/target

The AI keeps a set of fired cells. With no active target it fires at a random
unfired cell. A hit on an unsunk ship opens a target: it fires at the hit cell's
unfired neighbors in deterministic order **up, right, down, left**, then at
neighbors of any other hit cell of that ship. It never fires at a cell it has
already fired at.

## Caller-preference store (SQLite)

`better-sqlite3` keeps a caller-preference database at `data/caller-prefs.db`:

```sql
CREATE TABLE IF NOT EXISTS caller_prefs (
  caller_id  TEXT NOT NULL,
  game       TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (caller_id, game, key)
);
```

The caller id is the caller's number from `session.from` (E.164 string); if absent,
`'unknown'` is used. BattleFone reads/writes `ship_count` and `two_cell_count` under
`game='battlefone'`. The table is intentionally game-scoped so other phone games
(and a future hub number) can share the same database. All statements are prepared
and every DB call is wrapped in try/catch so a DB failure degrades to defaults
instead of crashing the call.

## Audio clips (sound-ready, TTS fallback)

The app checks `data/audio/` for optional clips:

| File          | Used for                                   | TTS fallback                              |
| ------------- | ------------------------------------------ | ----------------------------------------- |
| `sting.mp3`   | Played first on the welcome prompt         | (none; then welcome TTS)                  |
| `sonar.mp3`   | Miss                                       | "Miss."                                   |
| `explosion.mp3` | Hit                                      | "Hit!" / "They hit your ship."            |
| `sink.mp3`    | Sink                                       | "Hit! You sank my battleship!" / "They sank your battleship!" |
| `win.mp3`     | Victory                                    | "You sank the entire enemy fleet! Victory! Thanks for playing BattleFone." |
| `lose.mp3`    | Defeat                                     | "Your fleet has been destroyed. The enemy wins. Thanks for playing BattleFone." |

**Audio hosting (2026-08-24):** clips are served from the public S3 bucket
`platypus-jambonz-bucket` under `audio/battlefone/` — the same bucket as the alert
and Call Snare greeting clips, so audio doesn't depend on the game server or the
tunnel. The app keeps local copies in `data/audio/` as the presence gate: if a
clip file exists locally, the matching S3 URL is played; if absent, the app falls
back to the TTS phrasing above. With no clips present the game is fully TTS.

**Regenerating the kit:** `tools/make-sfx.py` (pure numpy synthesis + ffmpeg)
rebuilds all six clips — `python3 tools/make-sfx.py` with a numpy venv, then
`systemctl --user restart battlefone` is NOT needed (clips are checked per call;
just drop the files in `data/audio/`).

## Architecture notes

- **App-only voice.** No `conference` or `room` verb; the app TTS is the only voice.
- **DTMF-only input.** No STT/LLM/AI beyond the deterministic Battleship AI.
- **Keypad = board.** See the board map above.
- **Each call is its own WebSocket session.** `session:new` fires per incoming call;
  game state lives in a module-level `Map` keyed by `crypto.randomUUID()` and is
  removed on game end/hangup. The `GameState` object is structured so a second
  `session` reference can be added later for PvP.
- **Portal-configured TTS.** The app never calls `.config()` and never passes
  `synthesizer` in `say()`.
- **No env vars.** `createEndpoint({ ..., envVars: {} })`; no API keys, no LLM.

## v2 ideas (future work — not built in v1)

- **PvP two-phone lobby**: a second `session` reference per game, two callers,
  turn-by-turn shots, and `.send()` redirects to the other leg.
- **Manual ship placement**: DTMF walk through the keypad to place each ship cell
  by cell instead of auto-placement.
- **10x10 printed-grid edition**: larger board with a spoken/printed coordinate map
  (and a companion paper grid).
- **Hub number**: a main number that greets callers by name and offers a game menu
  (BattleFone plus other keypad games sharing the same `caller_prefs` DB).
- **Audio clip library**: richer sonar/explosion/sink/win/lose sound design.
- **Rematch stats**: persist wins/losses/accuracy per caller and narrate them on the
  next call.
