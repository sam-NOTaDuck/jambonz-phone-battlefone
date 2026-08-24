# TASK: Build "BattleFone" — a Jambonz voice app (brand new project)

Build a complete, working Jambonz WebSocket voice application from scratch in this
directory. A caller dials a phone number and plays a Battleship-style game against
the app's AI using the phone keypad. The board IS the keypad: digits 0-9 are the 10
cells. Ships are 1-2 cells. The app is the moderator and the opponent: it announces
the game, narrates every shot, enforces the rules, plays the AI, remembers the
caller's preferences, and handles the caller hanging up.

## Non-negotiable architecture decisions (already made — do not redesign)

1. **App-only voice.** No `conference` or `room` verb. The app (TTS) is the only
   voice the caller hears. v1 is single-player vs the AI (one session per game), but
   structure the game object so a second `session` reference can be added later
   (PvP is documented future work — do NOT build it now).
2. **DTMF-only input.** No speech recognition (STT), no LLM, no AI. Pure
   `gather({ input: ['digits'] })` + `say()` TTS. Deterministic state machine.
3. **Keypad = board.** The board is the telephone keypad layout, INCLUDING 0:
   ```
   1 2 3
   4 5 6
   7 8 9
     0
   ```
   There are 10 cells, indexed by the digits 0-9. Neighbors are cells sharing an
   edge on this layout:
   - Horizontal: 1-2, 2-3, 4-5, 5-6, 7-8, 8-9
   - Vertical: 1-4, 2-5, 3-6, 4-7, 5-8, 6-9, 8-0
   - 0 is adjacent ONLY to 8.
   A 2-cell ship occupies exactly two adjacent cells (e.g. [0, 8]). Ships never
   overlap. No translation layer needed — the keypad maps 1:1 to the board.
4. **Each call is its own WebSocket session.** In the jambonz WebSocket SDK, every
   incoming call fires `session:new` on the service. Game state (boards, fleets,
   turn, status) lives in a module-level `Map` keyed by a game id.
5. **Portal-configured TTS.** Do NOT call `.config({ synthesizer: ... })` and do NOT
   pass `synthesizer` in `say()` — the Jambonz portal application will have Google
   TTS configured at the app level. No recognizer is needed (DTMF only), so skip
   `.config()` entirely.
6. **No env vars required.** The app declares `envVars: {}` in `createEndpoint`.
   No API keys, no LLM. The only external state is the SQLite preferences file,
   created on first use under `./data/`.
7. **Shared caller-preference store (SQLite).** Use `better-sqlite3` to keep a
   caller-preference database at `data/caller-prefs.db`. Schema:
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
   Caller id = the caller's number from `session.from` (E.164 string); if absent,
   use `'unknown'`. BattleFone reads/writes keys under `game='battlefone'`
   (`ship_count`, `two_cell_count`). The table is intentionally game-scoped so
   other phone games (and a future hub number) can share the same database. Use
   prepared statements; wrap every DB call in try/catch so a DB failure degrades to
   defaults instead of crashing the call.

## Project scaffold (create in THIS directory)

```
npm init -y
npm install @jambonz/sdk better-sqlite3
npm install -D typescript @types/node @types/better-sqlite3 tsx
```

tsconfig.json: target ES2022, module commonjs, strict true, esModuleInterop true,
skipLibCheck true (REQUIRED — the SDK types reference internal modules), outDir
./dist, rootDir ./src, types ["node"].

package.json scripts: `"build": "tsc"`, `"start": "tsx src/app.ts"`.

## App behavior spec

### Welcome & main menu
- On `session:new`, load the caller's saved prefs (if any) before the first prompt.
- TTS: "Welcome to BattleFone." (play `sting.mp3` first if present — see Audio)
  then gather 1 digit (`/menu` actionHook):
  - Press 1 = **Instant Action**: use remembered prefs (or defaults), auto-place
    both fleets, play the AI immediately.
  - Press 5 = **Options**: configure the fleet.
- Re-prompt on timeout: "Press 1 for instant action, or 5 for options." Any other
  digit re-prompts.

### Options (config)
- "How many ships? Press 1, 2, or 3." (default 2; max 3 — more than 3 fills the board)
- "Ship sizes. Press 1 for all one-cell ships. Press 2 for one two-cell ship and
  the rest one-cell. Press 3 for random sizes." (choice 3 picks each ship's size 1
  or 2 randomly per game)
- Save to the prefs DB (`caller_id`, `'battlefone'`, `'ship_count'` /
  `'two_cell_count'`), then "Fleet saved." and start the game with the new fleet.

### Game setup (auto-place only in v1)
- Fleet = N ships (default 2). Sizes per composition (default: one 2-cell + one
  1-cell). N=1 with composition 2 is invalid — fall back to one 2-cell ship.
- Place the caller's fleet randomly: 1-cell ships on a random unused cell; 2-cell
  ships on a random cell + a random valid neighbor, retrying until non-overlapping.
  With ≤3 ships on 10 cells this always terminates quickly.
- Place the AI fleet identically (independently random).
- TTS: "Your fleet is set. Enemy fleet: {N} ships. Fire when ready. Your turn.
  Target a cell: zero through nine."

### Shoot loop (vs AI)
- Player's turn: gather 1 digit (`/fire` actionHook), timeout 15s, re-prompt on
  timeout: "Still your turn. Target a cell: zero through nine."
- Digit 0-9 → evaluate the shot against the enemy board:
  - Echo the shot: "Shot on {digit}." (0 spoken as "zero")
  - **Miss** (empty cell): "Miss." (or sonar audio)
  - **Hit** (occupied, ship not sunk): "Hit!" (or explosion audio)
  - **Sink** (last cell of a ship): "Hit! You sank my battleship!" (or sink audio)
  - Announce: "Enemy fleet: {N} ships remaining."
- Already-fired cell → "You already fired at {digit}. Pick a new target." then
  re-gather (no AI turn).
- After the player's shot, the AI fires:
  - TTS "Enemy firing." then a short pause (1-2s), then announce the AI's shot
    digit and its result against the player's board with the same miss/hit/sink
    phrasing (reversed: "They hit your ship." / "They sank your battleship!").
  - **AI algorithm — hunt/target:**
    - Keep a set of fired cells.
    - No active target → fire at a random unfired cell.
    - A hit on an unsunk ship opens a target: fire next at the hit cell's unfired
      neighbors (deterministic order: up, right, down, left per the adjacency map),
      then at neighbors of any other unfired cell of that ship.
    - Never fire at a fired cell.
- Win: player sinks all AI ships → "You sank the entire enemy fleet! Victory!
  Thanks for playing BattleFone."
- Lose: AI sinks all player ships → "Your fleet has been destroyed. The enemy
  wins. Thanks for playing BattleFone."
- After win/lose: "Press star to play again. Press pound for the main menu."
  (`/again` actionHook): `*` = new game with the same fleet (fresh random boards);
  `#` = main menu; timeout = "Thanks for playing. Goodbye." then hangup.

### Board model & helpers (put in src/game.ts)
- Two boards, `playerBoard` and `enemyBoard`: `string[10]`, each cell one of
  `'empty' | 'ship' | 'fired-empty' | 'fired-ship'`.
- Ship object: `{ id: number, cells: number[], sunk: boolean }`; fleet = array.
- `isAdjacent(a, b)` using the adjacency rules above.
- `placeFleet(sizes)` → random non-overlapping fleet of the requested sizes.
- `applyShot(board, fleet, digit)` → `{ hit: boolean, sunkShipId: number | null }`.
- `fleetRemaining(fleet)` → count of unsunk ships.
- Spoken-number helper: 0 → "zero", 1-9 as their names.

### Audio (sound-ready, TTS fallback)
- The app checks `data/audio/` for optional clips: `sting.mp3`, `sonar.mp3`
  (miss), `explosion.mp3` (hit), `sink.mp3`, `win.mp3`, `lose.mp3`. If a clip
  exists, play it (`play` verb with the file path, or serve ./data/audio statically
  on the same port — your choice, document it); otherwise fall back to the TTS
  phrasing above. With no clips present the game is fully TTS.
- Keep the narration punchy and game-like. Always echo the shot digit and result.

### Hangup handling
- `session.on('close')`: log the call end, remove the game from the map (v1 is
  solo — nothing to notify).
- Wrap EVERY async `session.on(...)` handler body in try-catch. Unhandled
  rejections inside EventEmitter handlers crash the whole Node process.

### Robustness requirements
- Module-level `games` Map keyed by `crypto.randomUUID()`; delete on game end/hangup.
- Log meaningful lines: `[bf] call <callSid> from <from>`, `[bf] prefs loaded <json>`,
  `[bf] game <id> created, fleet <sizes>`, `[bf] shot <digit> -> <result>`,
  `[bf] game <id> over: <win|lose>`, `[bf] call ended <callSid>`.
- DB failures must never crash the call: try/catch around every prefs read/write,
  default values on error.

## Verification (must pass before you finish)
1. `npm run build` → `tsc` compiles with zero errors.
2. `npm start` boots and prints a startup line ("BattleFone listening on port 3011"
   or similar). The HTTP endpoint should return 405 on plain GET (normal for a
   WebSocket jambonz app).
3. Fleet-placement sanity check: run a small tsx script (not part of the app) that
   places 100 random fleets of 2 ships (one 2-cell + one 1-cell) and asserts every
   ship's cells are in 0-9, 2-cell ships are adjacent, and no ships overlap.
   Print PASS/FAIL.
4. Include a `README.md` describing: how to run, how to provision a Jambonz app to
   point at this WebSocket (wss URL), the keypad board map, the config options, and
   v2 ideas (PvP two-phone lobby, manual ship placement, 10x10 printed-grid
   edition, hub number greeting callers by name with a game menu, audio clip
   library, rematch stats).

## Reference patterns (from our proven jambonz codebase — follow these exactly)

WebSocket entry point:
```typescript
import http from 'http';
import { createEndpoint } from '@jambonz/sdk/websocket';

const server = http.createServer();
const makeService = createEndpoint({ server, port: 3011, envVars: {} });
const svc = makeService({ path: '/' });

svc.on('session:new', (session) => {
  // session.callSid identifies this leg; session.from is the caller number
  // session.say({...}).gather({...}).send();   // initial verbs only
});

// actionHook events: session.on('/fire', async (evt) => { ... .reply(); });
// hangup: session.on('close', () => { ... });
```

DTMF gather (the pattern to use everywhere):
```typescript
session.gather({
  input: ['digits'],
  numDigits: 1,
  timeout: 15,
  actionHook: '/fire',
  say: { text: 'Your turn. Target a cell: zero through nine.' },
}).reply();   // in a hook handler
```

Same-leg actionHook responses ALWAYS use `.reply()`. The initial verb array in
`session:new` uses `.send()`. (v1 has a single session, but keep this discipline —
future PvP will need `.send()` redirects to the other leg.)

## What NOT to do
- Do NOT use the `conference` or `room` verbs.
- Do NOT use `llm`, `s2s`, or any AI/STT integration.
- Do NOT use `.config()`.
- Do NOT use `process.env` for anything.
- Do NOT add manual ship placement or a two-player lobby in v1 (document as future
  work in the README).
- Do NOT touch anything outside this directory.
- Do NOT create extra files beyond the project (package.json, tsconfig.json,
  src/app.ts, src/game.ts, README.md, .gitignore, data/ for the sqlite db).

When done, report: what you built, the file list, that `npm run build` passes, the
fleet-placement sanity check result, and any deviations from this spec.
