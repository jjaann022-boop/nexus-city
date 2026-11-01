import assert from 'node:assert/strict';
import { defaultBoard } from '../src/data/index.ts';
import { applyAction, createGame, currentPlayerId, getLegalActions } from '../src/engine/engine.ts';
import { EngineError } from '../src/engine/errors.ts';
import type { EngineErrorCode } from '../src/engine/errors.ts';
import { rollDice } from '../src/engine/rng.ts';
import type { Action, GameState, StepResult } from '../src/engine/types.ts';

export const board = defaultBoard;

export const PLAYERS = [
  { name: 'A', color: 'red' },
  { name: 'B', color: 'blue' },
  { name: 'C', color: 'green' },
  { name: 'D', color: 'yellow' },
  { name: 'E', color: 'purple' },
  { name: 'F', color: 'orange' },
];

export type Dice = [number, number];

export function newGame(count = 3, seed = 1): GameState {
  return createGame(board, PLAYERS.slice(0, count), seed);
}

/** Copy of `state` with `change` applied to the copy. */
export function patch(state: GameState, change: (draft: GameState) => void): GameState {
  const draft = structuredClone(state);
  change(draft);
  return draft;
}

/**
 * Sets the generator so the next roll satisfies `want`. It searches with the real dice
 * function, so no seed or dice outcome is hard-coded.
 */
export function forceRoll(state: GameState, want: (dice: Dice) => boolean): GameState {
  for (let candidate = 1; candidate < 200000; candidate++) {
    if (want(rollDice(candidate).dice)) {
      return patch(state, (d) => {
        d.rngState = candidate;
      });
    }
  }
  throw new Error('no generator state produces the requested roll');
}

export const totalIs =
  (n: number) =>
  (dice: Dice): boolean =>
    dice[0] + dice[1] === n;

export function act(state: GameState, action: Action): StepResult {
  return applyAction(board, state, action);
}

export function setPosition(state: GameState, playerId: number, position: number): GameState {
  return patch(state, (d) => {
    d.players[playerId].position = position;
  });
}

/**
 * Puts the current player `total` tiles before `tile`, forces that roll and applies it.
 * `tile` must be at least `total` so the walk does not cross the gate.
 */
export function rollOnto(state: GameState, tile: number, total = 4): StepResult {
  assert.ok(tile >= total, 'tile must be reachable without crossing the gate');
  const me = currentPlayerId(state);
  const ready = forceRoll(setPosition(state, me, tile - total), totalIs(total));
  return act(ready, { type: 'ROLL', playerId: me });
}

export function expectCode(fn: () => unknown, code: EngineErrorCode): void {
  assert.throws(
    fn,
    (err: unknown) => err instanceof EngineError && err.code === code,
    `expected EngineError with code ${code}`,
  );
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Rolls and settles the current turn without buying anything or collecting fees, then ends it. */
export function playTurn(state: GameState): GameState {
  const me = currentPlayerId(state);
  let s = act(state, { type: 'ROLL', playerId: me }).state;
  for (let guard = 0; guard < 10; guard++) {
    const legal = getLegalActions(board, s);
    const next =
      legal.find((a) => a.type === 'DECLINE_PURCHASE') ??
      legal.find((a) => a.type === 'WAIVE_FEE') ??
      legal.find((a) => a.type === 'END_TURN');
    if (!next) throw new Error(`stuck in phase ${s.phase}`);
    s = act(s, next).state;
    if (next.type === 'END_TURN') return s;
  }
  throw new Error('turn did not finish');
}

export function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
