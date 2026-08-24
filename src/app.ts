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

function getAudioUrl(game: GameState, filename: string): string | null {
  try {
    if (!game.audioBase) return null;
    const filePath = path.join(AUDIO_DIR, filename);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    return `${game.audioBase}/audio/${filename}`;
  } catch {
    return null;
  }
}

function pushAudioOrTts(session: Session, game: GameState, filename: string, ttsText: string): void {
  const url = getAudioUrl(game, filename);
  if (url) {
    session.play({ url });
  } else {
    session.say({ text: ttsText });
  }
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

function sendMenuPrompt(session: Session): void {
  session
    .gather({
      input: ['digits'],
      numDigits: 1,
      timeout: 15,
      actionHook: '/menu',
      say: { text: 'Press 1 for instant action, or 5 for options.' },
    })
    .reply();
}

function askShipCount(session: Session): void {
  session
    .gather({
      input: ['digits'],
      numDigits: 1,
      timeout: 15,
      actionHook: '/options-count',
      say: { text: 'How many ships? Press 1, 2, or 3.' },
    })
    .reply();
}

function askShipSizes(session: Session): void {
  session
    .gather({
      input: ['digits'],
      numDigits: 1,
      timeout: 15,
      actionHook: '/options-sizes',
      say: {
        text:
          'Ship sizes. Press 1 for all one-cell ships. Press 2 for one two-cell ship ' +
          'and the rest one-cell. Press 3 for random sizes.',
      },
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
      session.say({ text: sayFirst });
    }
    session
      .gather({
        input: ['digits'],
        numDigits: 1,
        timeout: 15,
        actionHook: '/fire',
        say: {
          text: `Your fleet is set. Enemy fleet: ${sizes.length} ships. Fire when ready. ` +
            'Your turn. Target a cell: zero through nine.',
        },
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
  if (result.sunkShipId !== null) {
    pushAudioOrTts(session, game, 'sink.mp3', 'Hit! You sank my battleship!');
  } else if (result.hit) {
    pushAudioOrTts(session, game, 'explosion.mp3', 'Hit!');
  } else {
    pushAudioOrTts(session, game, 'sonar.mp3', 'Miss.');
  }
}

function pushAiResult(session: Session, game: GameState, result: ShotResult): void {
  if (result.sunkShipId !== null) {
    pushAudioOrTts(session, game, 'sink.mp3', 'They sank your battleship!');
  } else if (result.hit) {
    pushAudioOrTts(session, game, 'explosion.mp3', 'They hit your ship.');
  } else {
    pushAudioOrTts(session, game, 'sonar.mp3', 'Miss.');
  }
}

function shotName(result: ShotResult): 'miss' | 'hit' | 'sink' {
  if (result.sunkShipId !== null) return 'sink';
  return result.hit ? 'hit' : 'miss';
}

function finishGame(session: Session, game: GameState, outcome: 'win' | 'lose'): void {
  game.phase = 'over';
  console.log(`[bf] game ${game.id} over: ${outcome}`);
  games.delete(game.id);

  if (outcome === 'win') {
    pushAudioOrTts(
      session,
      game,
      'win.mp3',
      'You sank the entire enemy fleet! Victory! Thanks for playing BattleFone.',
    );
  } else {
    pushAudioOrTts(
      session,
      game,
      'lose.mp3',
      'Your fleet has been destroyed. The enemy wins. Thanks for playing BattleFone.',
    );
  }

  session
    .gather({
      input: ['digits'],
      numDigits: 1,
      timeout: 15,
      actionHook: '/again',
      say: { text: 'Press star to play again. Press pound for the main menu.' },
    })
    .reply();
}

function enterMenu(session: Session, game: GameState): void {
  game.phase = 'menu';
  games.set(game.id, game);
  sendMenuPrompt(session);
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
      askShipCount(session);
      return;
    }
    // Timeout or any other digit re-prompts.
    sendMenuPrompt(session);
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
      askShipSizes(session);
      return;
    }
    askShipCount(session);
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
      askShipSizes(session);
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
          say: { text: 'Still your turn. Target a cell: zero through nine.' },
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
          say: { text: `You already fired at ${spokenNumber(digit)}. Pick a new target.` },
        })
        .reply();
      return;
    }

    const result = applyShot(game.enemyBoard, game.enemyFleet, digit);
    console.log(`[bf] shot ${digit} -> ${shotName(result)}`);

    session.say({ text: `Shot on ${spokenNumber(digit)}.` });
    pushPlayerResult(session, game, result);
    session.say({ text: `Enemy fleet: ${fleetRemaining(game.enemyFleet)} ships remaining.` });

    if (fleetRemaining(game.enemyFleet) === 0) {
      finishGame(session, game, 'win');
      return;
    }

    // AI's turn.
    session.say({ text: 'Enemy firing.' });
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

    session.say({ text: `Enemy fired on ${spokenNumber(aiDigit)}.` });
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
        say: { text: 'Your turn. Target a cell: zero through nine.' },
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
    session.say({ text: 'Thanks for playing. Goodbye.' }).hangup().reply();
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
        say: { text: 'Welcome to BattleFone. Press 1 for instant action, or 5 for options.' },
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
