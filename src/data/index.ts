import { parseBoard } from '../engine/board.ts';
import raw from './board.json' with { type: 'json' };

/** The validated placeholder board (see meta.note inside board.json). */
export const defaultBoard = parseBoard(raw);
