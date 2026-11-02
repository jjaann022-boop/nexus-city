export type District = 'commercial' | 'tech' | 'residential' | 'industrial';
export const DISTRICTS: readonly District[] = ['commercial', 'tech', 'residential', 'industrial'];

export type TileKind =
  | 'gate'
  | 'municipality'
  | 'financial_center'
  | 'transport_center'
  | 'real_estate_office'
  | 'property'
  | 'luck_or_mystery'
  | 'utility'
  | 'city_project';

export const TILE_KINDS: readonly TileKind[] = [
  'gate',
  'municipality',
  'financial_center',
  'transport_center',
  'real_estate_office',
  'property',
  'luck_or_mystery',
  'utility',
  'city_project',
];

export interface Tile {
  name: string;
  kind: TileKind;
  /** Required for property, luck_or_mystery, utility and city_project; forbidden otherwise. */
  district?: District;
  /** Original price. Required (positive multiple of 20) for property; forbidden otherwise. */
  price?: number;
}

export type LuckVoucher = 'purchase_discount' | 'gate_ticket' | 'fee_exemption' | 'card_payment_exemption';
export type MysteryVoucher = 'station_discount' | 'development_discount';

export type LuckEffect =
  | { type: 'gain'; amount: number }
  | { type: 'pay'; amount: number }
  | { type: 'gain_if_owns_property'; amount: number; otherwise: number }
  | { type: 'voucher'; voucher: LuckVoucher };

export type MysteryEffect =
  | { type: 'extra_roll' }
  | { type: 'move_to_nearest'; kind: TileKind }
  | { type: 'voucher'; voucher: MysteryVoucher }
  | { type: 'market_report' }
  // Needs the negotiation system (offers, auctions) or other rules that are not built yet.
  | { type: 'not_implemented' };

export interface LuckCard {
  id: string;
  name: string;
  effect: LuckEffect;
}

export interface MysteryCard {
  id: string;
  name: string;
  effect: MysteryEffect;
}

export interface Board {
  meta: { temporary: boolean; note: string };
  /** Clockwise order around the track. Index 0 is the gate. */
  tiles: Tile[];
  /** Brief section 12: the approved luck cards. */
  luckCards: LuckCard[];
  /** Brief section 13: the approved mystery box cards. */
  mysteryCards: MysteryCard[];
}

export interface PlayerSetup {
  name: string;
  color: string;
}

/** Counts of one-time benefits a player holds. */
export type VoucherKind =
  | 'purchase_discount' // luck 15: -200 on the next purchase from the bank
  | 'gate_ticket' // luck 16: +300 on the next pass of the gate
  | 'fee_exemption_armed' // luck 17: becomes active at the start of the player's next turn
  | 'fee_exemption_active' // waives the first landing fee owed during this turn, then expires with the turn
  | 'card_payment_exemption' // luck 19: waives the next amount a luck card makes the player pay the bank
  | 'station_discount' // mystery 10: -200 on one station built in the office
  | 'development_discount'; // mystery 17: -200 on one development step

export const VOUCHER_KINDS: readonly VoucherKind[] = [
  'purchase_discount',
  'gate_ticket',
  'fee_exemption_armed',
  'fee_exemption_active',
  'card_payment_exemption',
  'station_discount',
  'development_discount',
];

export interface PlayerState {
  /** Equals the index in GameState.players. */
  id: number;
  name: string;
  color: string;
  position: number;
  cash: number;
  /** Interest-free bank loan still owed. */
  bankDebt: number;
  /** Tiles of the utilities this player has activated (brief section 9). */
  utilities: number[];
  vouchers: Record<VoucherKind, number>;
}

export type Pending =
  | { type: 'purchase'; tile: number; price: number }
  // `owner` is whoever receives the fee and decides to collect or waive it: the property's owner,
  // or its tenant while it is leased.
  | { type: 'fee'; tile: number; payer: number; owner: number; amount: number }
  // The current player stands on a utility he has not activated yet.
  | { type: 'utility'; tile: number; cost: number }
  // cause 'fee': a landing fee that could not be paid. cause 'rent': rent due on completing a lap
  // (the landing on the tile where the move ended has not been resolved yet). cause 'card': a luck
  // card made him pay the bank (creditor 'bank').
  | {
      type: 'insolvent';
      cause: 'fee' | 'rent' | 'card';
      tile: number;
      payer: number;
      creditor: number | 'bank';
      amount: number;
    };

export type Phase =
  | 'awaiting_roll'
  | 'awaiting_purchase'
  | 'awaiting_fee_decision'
  | 'awaiting_end_turn'
  // The current player stands on a utility he has not activated and may activate it for 100.
  | 'awaiting_utility'
  // The current player stands on the real estate office and may develop and build stations.
  | 'in_office'
  // The current player cannot pay. Resolution rules arrive in phase 4; until then the game halts here.
  | 'insolvent';

export interface OpeningRoll {
  /** 1 = first throw; higher numbers are re-throws between tied players. */
  round: number;
  playerId: number;
  dice: [number, number];
  total: number;
}

export interface GameState {
  version: 1;
  rngState: number;
  players: PlayerState[];
  /** Player ids in playing order. */
  turnOrder: number[];
  /** Index into turnOrder of the player whose turn it is. */
  turnIndex: number;
  phase: Phase;
  pending: Pending | null;
  /** Tile index -> owner player id. Unowned properties are absent. */
  owners: Record<number, number>;
  /** Tile index -> development level above base (2 or 3). Absent means base level. */
  levels: Record<number, 2 | 3>;
  /**
   * Tile index -> owner of the station built on that property. Until sales exist
   * this always equals owners[tile] (separate station ownership is an open rule).
   */
  stations: Record<number, number>;
  /**
   * Tile index -> amount the owner received from the bank when mortgaging (and must repay to redeem).
   * A mortgaged property keeps its level and station but charges no landing fee and does not
   * count toward owning a whole district.
   */
  mortgaged: Record<number, number>;
  /** Tile index -> total actually paid for the development steps (steps can be discounted by vouchers). */
  developmentPaid: Record<number, number>;
  /** Tile index -> rental listing made by the owner (owners[tile]). laps null means open-ended. */
  leaseOffers: Record<number, { laps: number | null }>;
  /** Tile index -> active lease. lapsLeft counts the rent payments still due (null = open-ended). */
  leases: Record<number, { tenant: number; lapsLeft: number | null }>;
  lastRoll: [number, number] | null;
  openingRolls: OpeningRoll[];
}

export type Action =
  | { type: 'ROLL'; playerId: number }
  | { type: 'BUY'; playerId: number }
  | { type: 'DECLINE_PURCHASE'; playerId: number }
  | { type: 'COLLECT_FEE'; playerId: number }
  | { type: 'WAIVE_FEE'; playerId: number }
  /** Pay 100 to activate the utility you stand on (once per player). */
  | { type: 'ACTIVATE_UTILITY'; playerId: number }
  | { type: 'SKIP_UTILITY'; playerId: number }
  /** Raise one property by one level. Only inside the office. */
  | { type: 'DEVELOP'; playerId: number; tile: number }
  /** Build the station on an owned property: inside the office, or on the property you just landed on. */
  | { type: 'BUILD_STATION'; playerId: number; tile: number }
  /** Mortgage a property (with its level and station) to the bank. Only inside the office. */
  | { type: 'MORTGAGE'; playerId: number; tile: number }
  /** Repay the bank the exact mortgage amount. Only inside the office. */
  | { type: 'REDEEM'; playerId: number; tile: number }
  /** Owner offers a property for rent (laps = number of rent payments, or null for open-ended). Own turn only. */
  | { type: 'LIST_FOR_RENT'; playerId: number; tile: number; laps: number | null }
  | { type: 'CANCEL_LISTING'; playerId: number; tile: number }
  /** Rent a listed property. Only inside the office. */
  | { type: 'RENT'; playerId: number; tile: number }
  /** The owner ends a lease whenever he wants. Own turn only. */
  | { type: 'END_LEASE'; playerId: number; tile: number }
  | { type: 'LEAVE_OFFICE'; playerId: number }
  | { type: 'END_TURN'; playerId: number };

export type GameEvent =
  | { type: 'rolled'; playerId: number; dice: [number, number]; total: number }
  | { type: 'moved'; playerId: number; from: number; to: number }
  | { type: 'gate_bonus'; playerId: number; bonus: number; debtPaid: number; received: number }
  | { type: 'landed'; playerId: number; tile: number }
  | { type: 'tile_not_implemented'; playerId: number; tile: number; kind: TileKind }
  | { type: 'bought'; playerId: number; tile: number; price: number }
  | { type: 'purchase_declined'; playerId: number; tile: number }
  | { type: 'fee_due'; payer: number; owner: number; tile: number; amount: number }
  | { type: 'fee_paid'; payer: number; owner: number; tile: number; amount: number }
  | { type: 'fee_waived'; payer: number; owner: number; tile: number; amount: number }
  | {
      type: 'insolvent';
      cause: 'fee' | 'rent' | 'card';
      payer: number;
      creditor: number | 'bank';
      tile: number;
      amount: number;
    }
  /** Money between a player and the bank: positive = the bank pays the player, negative = the player pays the bank. */
  | { type: 'bank_transfer'; playerId: number; amount: number; reason: string }
  | { type: 'card_drawn'; playerId: number; deck: 'luck' | 'mystery'; cardId: string }
  | { type: 'card_not_implemented'; playerId: number; cardId: string }
  | { type: 'voucher_gained'; playerId: number; voucher: VoucherKind }
  | { type: 'voucher_used'; playerId: number; voucher: VoucherKind; amount: number }
  | { type: 'fee_exempted'; payer: number; owner: number; tile: number; amount: number }
  | { type: 'utility_activated'; playerId: number; tile: number }
  | { type: 'utility_skipped'; playerId: number; tile: number }
  | { type: 'utility_used'; playerId: number; tile: number; amount: number }
  | { type: 'market_report'; playerId: number; rentListings: number[] }
  | { type: 'listed_for_rent'; playerId: number; tile: number; laps: number | null }
  | { type: 'listing_cancelled'; playerId: number; tile: number }
  | { type: 'leased'; tenant: number; owner: number; tile: number; laps: number | null }
  | { type: 'rent_paid'; tenant: number; owner: number; tile: number; amount: number; lapsLeft: number | null }
  | { type: 'lease_ended'; tile: number; owner: number; tenant: number; reason: 'term' | 'owner' }
  | { type: 'office_entered'; playerId: number }
  | { type: 'developed'; playerId: number; tile: number; level: number; cost: number }
  | { type: 'station_built'; playerId: number; tile: number; cost: number }
  | { type: 'mortgaged'; playerId: number; tile: number; amount: number }
  | { type: 'redeemed'; playerId: number; tile: number; amount: number }
  | { type: 'no_fee_mortgaged'; payer: number; owner: number; tile: number }
  | { type: 'office_left'; playerId: number }
  | { type: 'turn_ended'; playerId: number }
  | { type: 'turn_started'; playerId: number };

export interface StepResult {
  state: GameState;
  events: GameEvent[];
}
