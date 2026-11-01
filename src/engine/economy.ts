import { RULES } from './rules.ts';
import type { Board, District, GameState } from './types.ts';

// Board validation guarantees property prices are positive even integers, so every
// percentage used below (50%, 100%, 150%, 200%) produces a whole number of liras.
function percentOf(price: number, percent: number): number {
  const value = (price * percent) / 100;
  if (!Number.isInteger(value)) throw new Error(`${percent}% of ${price} is not a whole number`);
  return value;
}

export function propertyPrice(board: Board, tile: number): number {
  return board.tiles[tile].price as number;
}

/** Cost of one development step (base -> 2, or 2 -> 3). */
export function developmentCost(price: number): number {
  return percentOf(price, RULES.developmentCostPercent);
}

/** Cost of building the station on a property. */
export function stationCost(price: number): number {
  return percentOf(price, RULES.stationCostPercent);
}

/** Level 1 is the base level; development raises it to 2 and 3. */
export function levelOf(state: GameState, tile: number): number {
  return state.levels[tile] ?? 1;
}

/**
 * Landing fee on an owned property (brief sections 6-7):
 * the property part by level (100% / 150% / 200% of the original price)
 * plus, if a station stands on it, half of the station's build cost.
 * Development never changes the station part.
 */
export function landingFee(board: Board, state: GameState, tile: number): number {
  const price = propertyPrice(board, tile);
  const levelPercent = RULES.levelFeePercent[levelOf(state, tile) - 1];
  let fee = percentOf(price, levelPercent);
  if (state.stations[tile] !== undefined) {
    fee += percentOf(stationCost(price), RULES.stationFeeAddOnPercent);
  }
  return fee;
}

/** True when `playerId` owns every property of the district. */
export function ownsFullDistrict(board: Board, state: GameState, playerId: number, district: District): boolean {
  let found = 0;
  for (let i = 0; i < board.tiles.length; i++) {
    const t = board.tiles[i];
    if (t.kind === 'property' && t.district === district) {
      if (state.owners[i] !== playerId) return false;
      found++;
    }
  }
  return found > 0;
}
