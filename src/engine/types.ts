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

export interface Tile {
  name: string;
  kind: TileKind;
  /** Required for property, luck_or_mystery, utility and city_project; forbidden otherwise. */
  district?: District;
  /** Original price. Required (positive, even) for property; forbidden otherwise. */
  price?: number;
}

export interface Board {
  meta: { temporary: boolean; note: string };
  /** Clockwise order around the track. Index 0 is the gate. */
  tiles: Tile[];
}

export interface PlayerSetup {
  name: string;
  color: string;
}

export interface PlayerState {
  /** Equals the index in GameState.players. */
  id: number;
  name: string;
  color: string;
  position: number;
  cash: number;
  /** Interest-free bank loan still owed. */
  bankDebt: number;
}

export type Pending =
  | { type: 'purchase'; tile: number; price: number }
  | { type: 'fee'; tile: number; payer: number; owner: number; amount: number }
  | { type: 'insolvent'; tile: number; payer: number; creditor: number; amount: number };

export type Phase =
  | 'awaiting_roll'
  | 'awaiting_purchase'
  | 'awaiting_fee_decision'
  | 'awaiting_end_turn'
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
  lastRoll: [number, number] | null;
  openingRolls: OpeningRoll[];
}

export type Action =
  | { type: 'ROLL'; playerId: number }
  | { type: 'BUY'; playerId: number }
  | { type: 'DECLINE_PURCHASE'; playerId: number }
  | { type: 'COLLECT_FEE'; playerId: number }
  | { type: 'WAIVE_FEE'; playerId: number }
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
  | { type: 'insolvent'; payer: number; creditor: number; tile: number; amount: number }
  | { type: 'turn_ended'; playerId: number }
  | { type: 'turn_started'; playerId: number };

export interface StepResult {
  state: GameState;
  events: GameEvent[];
}
