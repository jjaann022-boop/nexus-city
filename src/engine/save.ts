import { checkInvariants } from './engine.ts';
import type { Board, GameState } from './types.ts';

const FORMAT = 'nexus-city-save';

export class SaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveError';
  }
}

export function serializeGame(state: GameState): string {
  return JSON.stringify({ format: FORMAT, version: 1, state });
}

/** Parses and verifies a saved game. Throws SaveError for anything that is not a consistent save. */
export function deserializeGame(board: Board, text: string): GameState {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SaveError('save is not valid JSON');
  }
  if (typeof data !== 'object' || data === null) throw new SaveError('save has an unexpected shape');
  const record = data as Record<string, unknown>;
  if (record.format !== FORMAT) throw new SaveError('not a NEXUS CITY save');
  if (record.version !== 1) throw new SaveError(`unsupported save version ${String(record.version)}`);
  if (typeof record.state !== 'object' || record.state === null) throw new SaveError('save has no game state');

  const state = record.state as GameState;
  const problems = checkInvariants(board, state);
  if (problems.length > 0) throw new SaveError(`inconsistent save: ${problems.join('; ')}`);
  return state;
}
