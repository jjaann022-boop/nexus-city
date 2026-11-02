import { parseBoard } from '../engine/board.ts';
import rawTiles from './board.json' with { type: 'json' };
import luckCards from './luck_cards.json' with { type: 'json' };
import mysteryCards from './mystery_cards.json' with { type: 'json' };

/** The tiles (placeholder, see meta.note) merged with the approved card decks, before validation. */
export const rawBoard = { ...rawTiles, luckCards, mysteryCards };

/** The validated board. */
export const defaultBoard = parseBoard(rawBoard);
