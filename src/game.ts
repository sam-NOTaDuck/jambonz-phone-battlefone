// BattleFone game model: keypad board, fleets, shots, and the hunt/target AI.
// Pure game logic with no jambonz or HTTP dependencies.

export type CellState = 'empty' | 'ship' | 'fired-empty' | 'fired-ship';
export type Board = CellState[];

export interface Ship {
  id: number;
  cells: number[];
  sunk: boolean;
}

export type Fleet = Ship[];

export interface ShotResult {
  hit: boolean;
  sunkShipId: number | null;
}

export interface AiState {
  /** Cells the AI has already fired at (on the player's board). */
  fired: Set<number>;
  /** Ship currently being hunted, if any. */
  targetShipId: number | null;
  /** Hit cells of the targeted ship, in the order they were discovered. */
  targetHitOrder: number[];
}

export const BOARD_CELLS: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

// Edge-sharing adjacency on the telephone keypad layout (including 0 under 8):
//   1 2 3
//   4 5 6
//   7 8 9
//     0
export const NEIGHBORS: Readonly<Record<number, readonly number[]>> = {
  0: [8],
  1: [2, 4],
  2: [1, 3, 5],
  3: [2, 6],
  4: [1, 5, 7],
  5: [2, 4, 6, 8],
  6: [3, 5, 9],
  7: [4, 8],
  8: [5, 7, 9, 0],
  9: [6, 8],
};

// Same neighbors ordered up, right, down, left for the deterministic hunt AI.
export const DIRECTIONAL_NEIGHBORS: Readonly<Record<number, readonly number[]>> = {
  0: [8],
  1: [2, 4],
  2: [3, 5, 1],
  3: [6, 2],
  4: [5, 7, 1],
  5: [2, 6, 8, 4],
  6: [3, 9, 5],
  7: [8, 4],
  8: [5, 9, 0, 7],
  9: [8, 6],
};

const DIGIT_NAMES: readonly string[] = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
];

export function isAdjacent(a: number, b: number): boolean {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a > 9 || b < 0 || b > 9) {
    return false;
  }
  return NEIGHBORS[a].includes(b);
}

/** Spoken-number helper: 0 -> "zero", 1-9 -> their English names. */
export function spokenNumber(digit: number): string {
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
    return String(digit);
  }
  return DIGIT_NAMES[digit];
}

export function createBoard(): Board {
  return new Array<CellState>(10).fill('empty');
}

export function boardFromFleet(fleet: Fleet): Board {
  const board = createBoard();
  for (const ship of fleet) {
    for (const cell of ship.cells) {
      board[cell] = 'ship';
    }
  }
  return board;
}

function randomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

function randomUnusedCell(used: ReadonlySet<number>): number | null {
  const unused = BOARD_CELLS.filter((cell) => !used.has(cell));
  if (unused.length === 0) return null;
  return unused[randomInt(unused.length)];
}

function randomAdjacentPair(used: ReadonlySet<number>): [number, number] | null {
  // Random attempts first; with <=3 ships on 10 cells this terminates quickly.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const a = randomUnusedCell(used);
    if (a === null) return null;
    const candidates = NEIGHBORS[a].filter((b) => !used.has(b));
    if (candidates.length === 0) continue;
    return [a, candidates[randomInt(candidates.length)]];
  }
  // Deterministic fallback: first unused cell that has an unused neighbor.
  for (const a of BOARD_CELLS) {
    if (used.has(a)) continue;
    for (const b of NEIGHBORS[a]) {
      if (!used.has(b)) return [a, b];
    }
  }
  return null;
}

/** Place a random, non-overlapping fleet of the requested sizes (each 1 or 2). */
export function placeFleet(sizes: readonly number[]): Fleet {
  const used = new Set<number>();
  const fleet: Fleet = [];
  let nextId = 1;

  for (const size of sizes) {
    if (size !== 1 && size !== 2) {
      throw new Error(`Invalid ship size: ${size}`);
    }
    if (size === 1) {
      const cell = randomUnusedCell(used);
      if (cell === null) throw new Error('Unable to place 1-cell ship: board full');
      used.add(cell);
      fleet.push({ id: nextId++, cells: [cell], sunk: false });
    } else {
      const pair = randomAdjacentPair(used);
      if (pair === null) throw new Error('Unable to place 2-cell ship: no adjacent pair available');
      const [a, b] = pair;
      used.add(a);
      used.add(b);
      fleet.push({ id: nextId++, cells: [a, b], sunk: false });
    }
  }

  return fleet;
}

export function isFired(board: Board, digit: number): boolean {
  return board[digit] === 'fired-empty' || board[digit] === 'fired-ship';
}

/** Apply a shot to a board. Callers should check isFired() first. */
export function applyShot(board: Board, fleet: Fleet, digit: number): ShotResult {
  if (board[digit] === 'fired-empty' || board[digit] === 'fired-ship') {
    return { hit: false, sunkShipId: null };
  }

  const wasShip = board[digit] === 'ship';
  board[digit] = wasShip ? 'fired-ship' : 'fired-empty';

  if (!wasShip) {
    return { hit: false, sunkShipId: null };
  }

  const ship = fleet.find((s) => s.cells.includes(digit));
  if (!ship) {
    return { hit: false, sunkShipId: null };
  }

  const allHit = ship.cells.every((cell) => board[cell] === 'fired-ship');
  if (allHit) {
    ship.sunk = true;
    return { hit: true, sunkShipId: ship.id };
  }

  return { hit: true, sunkShipId: null };
}

export function fleetRemaining(fleet: Fleet): number {
  return fleet.reduce((count, ship) => count + (ship.sunk ? 0 : 1), 0);
}

/**
 * Resolve the fleet composition into concrete ship sizes.
 * twoCellCount: '0' = all one-cell, '1' (default) = one two-cell ship and the
 * rest one-cell, 'random' = each ship is randomly 1 or 2 cells per game.
 */
export function resolveFleetSizes(shipCount: number, twoCellCount: string): number[] {
  const n = Math.min(3, Math.max(1, Math.trunc(shipCount) || 1));

  if (twoCellCount === 'random') {
    return Array.from({ length: n }, () => (Math.random() < 0.5 ? 2 : 1));
  }

  if (twoCellCount === '0') {
    return new Array<number>(n).fill(1);
  }

  // Composition 2 (one two-cell ship + rest one-cell). A single-ship fleet with
  // this composition is invalid, so fall back to one 2-cell ship.
  if (n === 1) {
    return [2];
  }
  return [2, ...new Array<number>(n - 1).fill(1)];
}

export function newAiState(): AiState {
  return { fired: new Set<number>(), targetShipId: null, targetHitOrder: [] };
}

/** Record the AI's shot result and maintain the hunt/target state. */
export function updateAiTarget(
  ai: AiState,
  fleet: Fleet,
  digit: number,
  hit: boolean,
  sunkShipId: number | null,
): void {
  ai.fired.add(digit);

  if (!hit) return;

  const ship = fleet.find((s) => s.cells.includes(digit));
  if (!ship) return;

  if (ship.sunk || sunkShipId === ship.id) {
    if (ai.targetShipId === ship.id) {
      ai.targetShipId = null;
      ai.targetHitOrder = [];
    }
    return;
  }

  // A hit on an unsunk ship opens (or continues) a target.
  ai.targetShipId = ship.id;
  if (!ai.targetHitOrder.includes(digit)) {
    ai.targetHitOrder.push(digit);
  }
}

/**
 * Hunt/target AI: returns the next cell to fire at.
 * - With an active target, fire at the hit cells' unfired neighbors in
 *   up/right/down/left order.
 * - Otherwise fire at a random unfired cell.
 * - Never returns a cell that has already been fired.
 */
export function chooseAiTarget(fleet: Fleet, ai: AiState): number {
  if (ai.targetShipId !== null) {
    const ship = fleet.find((s) => s.id === ai.targetShipId);
    if (ship && !ship.sunk) {
      const candidates: number[] = [];
      for (const hitCell of ai.targetHitOrder) {
        for (const neighbor of DIRECTIONAL_NEIGHBORS[hitCell] ?? []) {
          if (!ai.fired.has(neighbor) && !candidates.includes(neighbor)) {
            candidates.push(neighbor);
          }
        }
      }
      const pick = candidates.find((c) => !ai.fired.has(c));
      if (pick !== undefined) return pick;
    }
    ai.targetShipId = null;
    ai.targetHitOrder = [];
  }

  const unfired = BOARD_CELLS.filter((cell) => !ai.fired.has(cell));
  if (unfired.length === 0) return -1;
  return unfired[randomInt(unfired.length)];
}
