// BattleFone — a Jambonz WebSocket keypad Battleship voice app.
// The keypad IS the board (digits 0-9). App-only voice, DTMF-only input,
// portal-configured TTS, and a SQLite caller-preference store.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { createEndpoint, Session } from '@jambonz/sdk/websocket';
import {
  AiState,
  Board,
  Fleet,
  ShotResult,
  applyShot,
  boardFromFleet,
  chooseAiTarget,
  fleetRemaining,
  isFired,
  newAiState,
  placeFleet,
  resolveFleetSizes,
  spokenNumber,
  updateAiTarget,
} from './game';

const PORT = 3011;
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const DB_PATH = path.join(DATA_DIR, 'caller-prefs.db');

const GAME_NAME = 'battlefone';
const DEFAULT_SHIP_COUNT = 2;
const DEFAULT_TWO_CELL_COUNT = '1'; // one 2-cell ship + rest 1-cell

type TwoCellPref = '0' | '1' | 'random';

interface Prefs {
  shipCount: number;
  twoCellCount: TwoCellPref;
}

interface GameState {
  id: string;
  callSid: string;
  callerId: string;
  prefs: Prefs;
  shipCount: number;
  twoCellCount: TwoCellPref;
  sizes: number[];
  playerBoard: Board;
  enemyBoard: Board;
  playerFleet: Fleet;
  enemyFleet: Fleet;
  ai: AiState;
  phase: 'menu' | 'playing' | 'over';
  rounds: number;
  /** Base URL derived from the WebSocket Host header, used to serve audio clips. */
  audioBase: string | null;
}

interface GatherEvent {
  reason?: string;
  digits?: string;
  [key: string]: unknown;
}

const games = new Map<string, GameState>();

// ---------------------------------------------------------------------------
// SQLite caller-preference store (game-scoped so other phone games can share it)
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;
let stmtGetPrefs: Database.Statement | null = null;
let stmtSetPref: Database.Statement | null = null;

function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS caller_prefs (
      caller_id  TEXT NOT NULL,
      game       TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (caller_id, game, key)
    );
  `);
  stmtGetPrefs = db.prepare(
    'SELECT key, value FROM caller_prefs WHERE caller_id = ? AND game = ?',
  );
  stmtSetPref = db.prepare(
    `INSERT OR REPLACE INTO caller_prefs (caller_id, game, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  return db;
}

function normalizePrefs(rows: { key: string; value: string }[]): Prefs {
  const map = new Map(rows.map((row) => [row.key, row.value]));

  const rawCount = parseInt(map.get('ship_count') ?? '', 10);
  const shipCount = Number.isFinite(rawCount)
    ? Math.min(3, Math.max(1, rawCount))
    : DEFAULT_SHIP_COUNT;

  const rawTwo = map.get('two_cell_count');
  const twoCellCount: TwoCellPref =
    rawTwo === '0' ? '0' : rawTwo === 'random' ? 'random' : DEFAULT_TWO_CELL_COUNT;

  return { shipCount, twoCellCount };
}

function loadPrefs(callerId: string): Prefs {
  try {
    getDb();
    const rows = stmtGetPrefs!.all(callerId, GAME_NAME) as { key: string; value: string }[];
    const prefs = normalizePrefs(rows);
    console.log(`[bf] prefs loaded ${JSON.stringify(prefs)}`);
    return prefs;
  } catch (err) {
    console.error('[bf] prefs load failed, using defaults:', err);
    return { shipCount: DEFAULT_SHIP_COUNT, twoCellCount: DEFAULT_TWO_CELL_COUNT };
  }
}

function savePrefs(callerId: string, prefs: Prefs): void {
  try {
    getDb();
    const now = Date.now();
    stmtSetPref!.run(callerId, GAME_NAME, 'ship_count', String(prefs.shipCount), now);
    stmtSetPref!.run(callerId, GAME_NAME, 'two_cell_count', prefs.twoCellCount, now);
    console.log(`[bf] prefs saved ${JSON.stringify(prefs)}`);
  } catch (err) {
    console.error('[bf] prefs save failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Audio support (optional clips under data/audio; TTS is always the fallback)
// ---------------------------------------------------------------------------

function computeAudioBase(req?: http.IncomingMessage): string | null {
  try {
    if (!req || !req.headers.host) return null;
    const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
    const scheme = encrypted ? 'https' : 'http';
    return `${scheme}://${req.headers.host}`;
  } catch {
    return null;
  }
}

// Public bucket where all jambonz audio clips live (alert, Call Snare greetings,
// BattleFone). Kept in S3 so audio doesn't depend on the game server or tunnel.
const AUDIO_BASE_URL = 'https://platypus-jambonz-bucket.s3.amazonaws.com/audio/battlefone';

function getAudioUrl(_game: GameState, filename: string): string | null {
  try {
    const filePath = path.join(AUDIO_DIR, filename);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    return `${AUDIO_BASE_URL}/${filename}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phrase bank — every narration phrase is pre-generated as an audio clip
// (data/audio/tts/, mirrored to S3) so the game never relies on live TTS.
// Live TTS remains only as a fallback for unmapped phrases.
// ---------------------------------------------------------------------------

const PHRASE_CLIPS: Record<string, string> = {
  'Welcome to BattleFone. Press 1 for instant action, or 5 for options.': 'welcome',
  'Press 1 for instant action, or 5 for options.': 'menu',
  'How many ships? Press 1, 2, or 3.': 'ship-count',
  'Ship sizes. Press 1 for all one-cell ships. Press 2 for one two-cell ship and the rest one-cell. Press 3 for random sizes.': 'ship-sizes',
  'Fleet saved.': 'fleet-saved',
  'Press star to play again. Press pound for the main menu.': 'rematch',
  'Still your turn. Target a cell: zero through nine.': 'still-turn',
  'Your turn. Target a cell: zero through nine.': 'your-turn',
  'Enemy firing.': 'enemy-firing',
  'Thanks for playing. Goodbye.': 'goodbye',
  'Miss.': 'miss',
  'Hit!': 'hit',
  'Hit! You sank my ship!': 'sank',
  'They hit your ship.': 'they-hit',
  'They sank your ship!': 'they-sank',
  'You sank the entire enemy fleet! Every last ship is at the bottom of the ocean. Victory! Thanks for playing BattleFone.': 'win',
  'All of your ships have been sunk. The enemy fleet claims victory. Thanks for playing BattleFone.': 'lose',
  'Your fleet is set. Enemy fleet: 1 ship. Fire when ready. Your turn. Target a cell: zero through nine.': 'fleet-set-1',
  'Your fleet is set. Enemy fleet: 2 ships. Fire when ready. Your turn. Target a cell: zero through nine.': 'fleet-set-2',
  'Your fleet is set. Enemy fleet: 3 ships. Fire when ready. Your turn. Target a cell: zero through nine.': 'fleet-set-3',
  'Enemy fleet: 1 ship remaining.': 'fleet-remaining-1',
  'Enemy fleet: 2 ships remaining.': 'fleet-remaining-2',
  'Enemy fleet: 3 ships remaining.': 'fleet-remaining-3',
};
for (const w of ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']) {
  PHRASE_CLIPS[`Shot on ${w}.`] = `shot-on-${w}`;
  PHRASE_CLIPS[`Enemy fired on ${w}.`] = `enemy-fired-${w}`;
  PHRASE_CLIPS[`You already fired at ${w}. Pick a new target.`] = `already-fired-${w}`;
}

/** Fluent: play the pre-generated clip for this phrase, or fall back to live TTS. */
function speak(session: Session, game: GameState, text: string): Session {
  const slug = PHRASE_CLIPS[text];
  if (slug) {
    const url = getAudioUrl(game, `tts/${slug}.mp3`);
    if (url) return session.play({ url });
  }
  return session.say({ text });
}

/** Build the say/play option for a gather prompt (clips preferred, TTS fallback). */
function sayOrPlayOption(game: GameState, text: string): { say?: { text: string }; play?: { url: string } } {
  const slug = PHRASE_CLIPS[text];
  if (slug) {
    const url = getAudioUrl(game, `tts/${slug}.mp3`);
    if (url) return { play: { url } };
  }
  return { say: { text } };
}

// ---------------------------------------------------------------------------
// HTTP handler (also serves data/audio on the same port)
// ---------------------------------------------------------------------------

function installHttpHandler(server: http.Server): void {
  // The SDK installs a catch-all request listener (405 / OPTIONS envVars).
  // Replace it with one that also serves ./data/audio on the same port.
  for (const listener of server.listeners('request')) {
    server.removeListener('request', listener as (...args: any[]) => void);
  }

  server.on('request', (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname.startsWith('/audio/')) {
          const filename = decodeURIComponent(path.basename(url.pathname));
          if (
            !filename ||
            filename === '.' ||
            filename === '..' ||
            filename.includes('/') ||
            filename.includes('\\')
          ) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
          }

          const filePath = path.resolve(AUDIO_DIR, filename);
          if (!filePath.startsWith(path.resolve(AUDIO_DIR) + path.sep)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
          }

          if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
          }

          const stat = fs.statSync(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const contentType =
            ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size });
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          fs.createReadStream(filePath).pipe(res);
          return;
        }
      }

      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    } catch (err) {
      console.error('[bf] http handler error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end('Internal Server Error');
    }
  });
}

// ---------------------------------------------------------------------------
// Prompts / game flow helpers
// ---------------------------------------------------------------------------

function sendMenuPrompt(session: Session, game: GameState): void {
  session
    .gather({
      input: ['digits'],
      numDigits: 1,
      timeout: 15,
      actionHook: '/menu',
      ...sayOrPlayOption(game, 'Press 1 for instant action, or 5 for options.'),
    })
    .reply();
}

function askShipCount(session: Session, game: GameState): void {
  session
    .gather({
      input: ['digits'],
      numDigits: 1,
      timeout: 15,
      actionHook: '/options-count',
      ...sayOrPlayOption(game, 'How many ships? Press 1, 2, or 3.'),
    })
    .reply();
}

function askShipSizes(session: Session, game: GameState): void {
  session
    .gather({
      input: ['digits'],
      numDigits: 1,
      timeout: 15,
      actionHook: '/options-sizes',
      ...sayOrPlayOption(
        game,
        'Ship sizes. Press 1 for all one-cell ships. Press 2 for one two-cell ship and the rest one-cell. Press 3 for random sizes.',
      ),
    })
    .reply();
}

function startRound(session: Session, game: GameState, sayFirst?: string): void {
  try {
    const sizes = resolveFleetSizes(game.shipCount, game.twoCellCount);
    game.sizes = sizes;
    game.playerFleet = placeFleet(sizes);
    game.enemyFleet = placeFleet(sizes);
    game.playerBoard = boardFromFleet(game.playerFleet);
    game.enemyBoard = boardFromFleet(game.enemyFleet);
    game.ai = newAiState();
    game.phase = 'playing';
    games.set(game.id, game);

    const fleetLabel = sizes.join(',');
    if (game.rounds === 0) {
      console.log(`[bf] game ${game.id} created, fleet ${fleetLabel}`);
    } else {
      console.log(`[bf] game ${game.id} restarted, fleet ${fleetLabel}`);
    }
    game.rounds += 1;

    if (sayFirst) {
      speak(session, game, sayFirst);
    }
    const fleetWord = sizes.length === 1 ? 'ship' : 'ships';
    session
      .gather({
        input: ['digits'],
        numDigits: 1,
        timeout: 15,
        actionHook: '/fire',
        ...sayOrPlayOption(
          game,
          `Your fleet is set. Enemy fleet: ${sizes.length} ${fleetWord}. Fire when ready. ` +
            'Your turn. Target a cell: zero through nine.',
        ),
      })
      .reply();
  } catch (err) {
    console.error('[bf] startRound error:', err);
    try {
      session.hangup().reply();
    } catch {
      /* noop */
    }
  }
}

function pushPlayerResult(session: Session, game: GameState, result: ShotResult): void {
  const clip = result.sunkShipId !== null ? 'sink.mp3' : result.hit ? 'explosion.mp3' : 'sonar.mp3';
  const phrase =
    result.sunkShipId !== null ? 'Hit! You sank my battleship!' : result.hit ? 'Hit!' : 'Miss.';
  // Sound first, then the words — new players need the narration, not just the clip.
  const url = getAudioUrl(game, clip);
  if (url) {
    session.play({ url });
  }
  speak(session, game, phrase);
}

function pushAiResult(session: Session, game: GameState, result: ShotResult): void {
  const clip = result.sunkShipId !== null ? 'sink.mp3' : result.hit ? 'explosion.mp3' : 'sonar.mp3';
  const phrase =
    result.sunkShipId !== null
      ? 'They sank your battleship!'
      : result.hit
        ? 'They hit your ship.'
        : 'Miss.';
  const url = getAudioUrl(game, clip);
  if (url) {
    session.play({ url });
  }
  speak(session, game, phrase);
}

function shotName(result: ShotResult): 'miss' | 'hit' | 'sink' {
  if (result.sunkShipId !== null) return 'sink';
  return result.hit ? 'hit' : 'miss';
}

function finishGame(session: Session, game: GameState, outcome: 'win' | 'lose'): void {
  game.phase = 'over';
  console.log(`[bf] game ${game.id} over: ${outcome}`);
  games.delete(game.id);

  const clip = outcome === 'win' ? 'win.mp3' : 'lose.mp3';
  const announcement =
    outcome === 'win'
      ? 'You sank the entire enemy fleet! Every last ship is at the bottom of the ocean. Victory! Thanks for playing BattleFone.'
      : 'All of your ships have been sunk. The enemy fleet claims victory. Thanks for playing BattleFone.';

  // Play the clip (if present), THEN speak the announcement, then offer a rematch.
  const url = getAudioUrl(game, clip);
  let chain = session;
  if (url) {
    chain = session.play({ url });
  }
  chain = speak(chain, game, announcement);
  chain
    .gather({
      input: ['digits'],
      numDigits: 1,
      timeout: 15,
      actionHook: '/again',
      ...sayOrPlayOption(game, 'Press star to play again. Press pound for the main menu.'),
    })
    .reply();
}

function enterMenu(session: Session, game: GameState): void {
  game.phase = 'menu';
  games.set(game.id, game);
  sendMenuPrompt(session, game);
}

// ---------------------------------------------------------------------------
// actionHook handlers
// ---------------------------------------------------------------------------

function handleMenu(session: Session, game: GameState, evt: GatherEvent): void {
  try {
    if (evt.digits === '1') {
      // Instant action: remembered prefs (or defaults), auto-place both fleets.
      startRound(session, game);
      return;
    }
    if (evt.digits === '5') {
      askShipCount(session, game);
      return;
    }
    // Timeout or any other digit re-prompts.
    sendMenuPrompt(session, game);
  } catch (err) {
    console.error('[bf] menu handler error:', err);
    try {
      session.hangup().reply();
    } catch {
      /* noop */
    }
  }
}

function handleOptionsCount(session: Session, game: GameState, evt: GatherEvent): void {
  try {
    if (evt.digits === '1' || evt.digits === '2' || evt.digits === '3') {
      game.shipCount = parseInt(evt.digits, 10);
      askShipSizes(session, game);
      return;
    }
    askShipCount(session, game);
  } catch (err) {
    console.error('[bf] options-count handler error:', err);
    try {
      session.hangup().reply();
    } catch {
      /* noop */
    }
  }
}

function handleOptionsSizes(session: Session, game: GameState, evt: GatherEvent): void {
  try {
    if (evt.digits === '1') {
      game.twoCellCount = '0';
    } else if (evt.digits === '2') {
      game.twoCellCount = '1';
    } else if (evt.digits === '3') {
      game.twoCellCount = 'random';
    } else {
      askShipSizes(session, game);
      return;
    }

    savePrefs(game.callerId, { shipCount: game.shipCount, twoCellCount: game.twoCellCount });
    startRound(session, game, 'Fleet saved.');
  } catch (err) {
    console.error('[bf] options-sizes handler error:', err);
    try {
      session.hangup().reply();
    } catch {
      /* noop */
    }
  }
}

function handleFire(session: Session, game: GameState, evt: GatherEvent): void {
  try {
    const raw = evt.digits ?? '';
    if (!/^[0-9]$/.test(raw)) {
      // Timeout or a non-board digit re-prompts; no AI turn.
      session
        .gather({
          input: ['digits'],
          numDigits: 1,
          timeout: 15,
          actionHook: '/fire',
          ...sayOrPlayOption(game, 'Still your turn. Target a cell: zero through nine.'),
        })
        .reply();
      return;
    }

    const digit = parseInt(raw, 10);

    if (isFired(game.enemyBoard, digit)) {
      session
        .gather({
          input: ['digits'],
          numDigits: 1,
          timeout: 15,
          actionHook: '/fire',
          ...sayOrPlayOption(game, `You already fired at ${spokenNumber(digit)}. Pick a new target.`),
        })
        .reply();
      return;
    }

    const result = applyShot(game.enemyBoard, game.enemyFleet, digit);
    console.log(`[bf] shot ${digit} -> ${shotName(result)}`);

    speak(session, game, `Shot on ${spokenNumber(digit)}.`);
    pushPlayerResult(session, game, result);
    const enemyRemaining = fleetRemaining(game.enemyFleet);
    speak(
      session,
      game,
      `Enemy fleet: ${enemyRemaining} ${enemyRemaining === 1 ? 'ship' : 'ships'} remaining.`,
    );

    if (enemyRemaining === 0) {
      finishGame(session, game, 'win');
      return;
    }

    // AI's turn.
    speak(session, game, 'Enemy firing.');
    session.pause({ length: 1 + Math.random() });

    const aiDigit = chooseAiTarget(game.playerFleet, game.ai);
    if (aiDigit < 0 || aiDigit > 9) {
      console.error('[bf] AI could not choose a target');
      try {
        session.hangup().reply();
      } catch {
        /* noop */
      }
      return;
    }

    const aiResult = applyShot(game.playerBoard, game.playerFleet, aiDigit);
    updateAiTarget(game.ai, game.playerFleet, aiDigit, aiResult.hit, aiResult.sunkShipId);
    console.log(`[bf] ai shot ${aiDigit} -> ${shotName(aiResult)}`);

    speak(session, game, `Enemy fired on ${spokenNumber(aiDigit)}.`);
    pushAiResult(session, game, aiResult);

    if (fleetRemaining(game.playerFleet) === 0) {
      finishGame(session, game, 'lose');
      return;
    }

    session
      .gather({
        input: ['digits'],
        numDigits: 1,
        timeout: 15,
        actionHook: '/fire',
        ...sayOrPlayOption(game, 'Your turn. Target a cell: zero through nine.'),
      })
      .reply();
  } catch (err) {
    console.error('[bf] fire handler error:', err);
    try {
      session.hangup().reply();
    } catch {
      /* noop */
    }
  }
}

function handleAgain(session: Session, game: GameState, evt: GatherEvent): void {
  try {
    if (evt.digits === '*') {
      // New game with the same fleet preferences (fresh random boards).
      startRound(session, game);
      return;
    }
    if (evt.digits === '#') {
      enterMenu(session, game);
      return;
    }
    // Timeout (or any other key) ends the call.
    speak(session, game, 'Thanks for playing. Goodbye.').hangup().reply();
  } catch (err) {
    console.error('[bf] again handler error:', err);
    try {
      session.hangup().reply();
    } catch {
      /* noop */
    }
  }
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

const server = http.createServer();

server.on('error', (err) => {
  console.error('[bf] server error:', err);
  process.exit(1);
});

server.on('listening', () => {
  console.log(`BattleFone listening on port ${PORT}`);
});

const makeService = createEndpoint({ server, port: PORT, envVars: {} });
const svc = makeService({ path: '/' });

installHttpHandler(server);

svc.on('session:new', (session, _path, req) => {
  try {
    const callSid = session.callSid;
    const callerId = session.from || 'unknown';
    console.log(`[bf] call ${callSid} from ${callerId}`);

    const prefs = loadPrefs(callerId);
    const game: GameState = {
      id: randomUUID(),
      callSid,
      callerId,
      prefs,
      shipCount: prefs.shipCount,
      twoCellCount: prefs.twoCellCount,
      sizes: [],
      playerBoard: [],
      enemyBoard: [],
      playerFleet: [],
      enemyFleet: [],
      ai: newAiState(),
      phase: 'menu',
      rounds: 0,
      audioBase: computeAudioBase(req),
    };
    games.set(game.id, game);

    session.on('close', (_code: number, _reason: Buffer) => {
      try {
        games.delete(game.id);
        console.log(`[bf] call ended ${callSid}`);
      } catch (err) {
        console.error('[bf] close handler error:', err);
      }
    });

    session.on('/menu', (evt: GatherEvent) => handleMenu(session, game, evt));
    session.on('/options-count', (evt: GatherEvent) => handleOptionsCount(session, game, evt));
    session.on('/options-sizes', (evt: GatherEvent) => handleOptionsSizes(session, game, evt));
    session.on('/fire', (evt: GatherEvent) => handleFire(session, game, evt));
    session.on('/again', (evt: GatherEvent) => handleAgain(session, game, evt));

    const stingUrl = getAudioUrl(game, 'sting.mp3');
    if (stingUrl) {
      session.play({ url: stingUrl });
    }
    session
      .gather({
        input: ['digits'],
        numDigits: 1,
        timeout: 15,
        actionHook: '/menu',
        ...sayOrPlayOption(game, 'Welcome to BattleFone. Press 1 for instant action, or 5 for options.'),
      })
      .send();
  } catch (err) {
    console.error('[bf] session:new handler error:', err);
    try {
      session.hangup().send();
    } catch {
      /* noop */
    }
  }
});
