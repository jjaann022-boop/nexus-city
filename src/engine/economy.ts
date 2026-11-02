import { RULES } from './rules.ts';
import type { Board, District, GameState, PlayerState } from './types.ts';

// Board validation guarantees property prices are positive multiples of 20, so every
// percentage used below (5%, 10%, 20%, 30%, 50%, 100%) produces a whole number of liras.
function percentOf(price: number, percent: number): number {
  const value = (price * percent) / 100;
  if (!Number.isInteger(value)) throw new Error(`${percent}% of ${price} is not a whole number`);
  return value;
}

export function propertyPrice(board: Board, tile: number): number {
  return board.tiles[tile].price as number;
}

/** Standard cost of one development step (base -> 2, or 2 -> 3), before any voucher. */
export function developmentCost(price: number): number {
  return percentOf(price, RULES.developmentCostPercent);
}

/** Cost of building the station on a property (also the station's price when mortgaged). */
export function stationCost(price: number): number {
  return percentOf(price, RULES.stationCostPercent);
}

/** Rent paid by a tenant to the owner each lap (50% of the original price). */
export function rentAmount(price: number): number {
  return percentOf(price, RULES.rentPercent);
}

/** Level 1 is the base level; development raises it to 2 and 3. */
export function levelOf(state: GameState, tile: number): number {
  return state.levels[tile] ?? 1;
}

/**
 * Landing fee on an owned property:
 * the property part by level (10% / 20% / 30% of the original price)
 * plus, if a station stands on it, 5% of the original price (the station's build cost).
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

/** True when the player has activated the utility of that district. */
export function hasUtility(board: Board, player: PlayerState, district: District): boolean {
  return player.utilities.some((tile) => board.tiles[tile]?.district === district);
}

/**
 * What the player pays the bank for an unowned property: the original price, minus 10% for
 * commercial properties when he activated the shopping center, then minus the 200 voucher.
 */
export function purchaseCost(
  board: Board,
  state: GameState,
  playerId: number,
  tile: number,
  withVoucher = true,
): number {
  const player = state.players[playerId];
  const price = propertyPrice(board, tile);
  let cost = price;
  if (board.tiles[tile].district === 'commercial' && hasUtility(board, player, 'commercial')) {
    cost -= percentOf(price, RULES.utilityDiscountPercent);
  }
  if (withVoucher && player.vouchers.purchase_discount > 0) cost = Math.max(0, cost - RULES.purchaseVoucherAmount);
  return cost;
}

/**
 * What the player pays to build a station: the build cost, minus 10% in the tech and industrial
 * districts when he activated that district's utility, then (office only) minus the 200 voucher.
 */
export function stationBuildCost(
  board: Board,
  state: GameState,
  playerId: number,
  tile: number,
  viaOffice: boolean,
  withVoucher = true,
): number {
  const player = state.players[playerId];
  const district = board.tiles[tile].district as District;
  const full = stationCost(propertyPrice(board, tile));
  let cost = full;
  if ((district === 'tech' || district === 'industrial') && hasUtility(board, player, district)) {
    cost -= percentOf(full, RULES.utilityDiscountPercent);
  }
  if (withVoucher && viaOffice && player.vouchers.station_discount > 0) cost = Math.max(0, cost - RULES.stationVoucherAmount);
  return cost;
}

/** What the player pays for the next development step of a property (after the 200 voucher, if any). */
export function developmentStepCost(
  board: Board,
  state: GameState,
  playerId: number,
  tile: number,
  withVoucher = true,
): number {
  const standard = developmentCost(propertyPrice(board, tile));
  return withVoucher && state.players[playerId].vouchers.development_discount > 0
    ? Math.max(0, standard - RULES.developmentVoucherAmount)
    : standard;
}

/** What was actually paid so far for the development of a property. */
export function developmentPaid(state: GameState, tile: number): number {
  return state.developmentPaid[tile] ?? 0;
}

/**
 * What the owner receives from the bank for mortgaging (and repays to redeem):
 * original price + development actually paid + the station's price if one stands on the property.
 */
export function mortgageValue(board: Board, state: GameState, tile: number): number {
  const price = propertyPrice(board, tile);
  const station = state.stations[tile] !== undefined ? stationCost(price) : 0;
  return price + developmentPaid(state, tile) + station;
}

/**
 * True when `playerId` owns every property of the district. A mortgaged property does not
 * count: while one is mortgaged the district cannot be developed.
 */
export function ownsFullDistrict(board: Board, state: GameState, playerId: number, district: District): boolean {
  let found = 0;
  for (let i = 0; i < board.tiles.length; i++) {
    const t = board.tiles[i];
    if (t.kind === 'property' && t.district === district) {
      if (state.owners[i] !== playerId || state.mortgaged[i] !== undefined) return false;
      found++;
    }
  }
  return found > 0;
}
