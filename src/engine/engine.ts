import { validateBoard } from './board.ts';
import {
  developmentPaid,
  developmentStepCost,
  hasUtility,
  landingFee,
  levelOf,
  mortgageValue,
  ownsFullDistrict,
  propertyPrice,
  purchaseCost,
  rentAmount,
  stationBuildCost,
  stationCost,
} from './economy.ts';
import { EngineError } from './errors.ts';
import type { EngineErrorCode } from './errors.ts';
import { nextFloat, rollDice } from './rng.ts';
import { RULES } from './rules.ts';
import type {
  Action,
  Board,
  District,
  GameEvent,
  GameState,
  LuckEffect,
  MysteryEffect,
  OpeningRoll,
  Pending,
  Phase,
  PlayerSetup,
  PlayerState,
  StepResult,
  TileKind,
  VoucherKind,
} from './types.ts';
import { VOUCHER_KINDS } from './types.ts';

const MAX_OPENING_ROUNDS = 50;

// State is plain JSON, so a JSON round trip is a safe deep copy everywhere (browser, WebView, Node).
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptyVouchers(): Record<VoucherKind, number> {
  return Object.fromEntries(VOUCHER_KINDS.map((kind) => [kind, 0])) as Record<VoucherKind, number>;
}

export function currentPlayerId(state: GameState): number {
  return state.turnOrder[state.turnIndex];
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function createGame(board: Board, players: PlayerSetup[], seed: number): GameState {
  const boardErrors = validateBoard(board);
  if (boardErrors.length > 0) throw new EngineError('invalid_board', boardErrors.join('; '));

  if (!Array.isArray(players) || players.length < RULES.minPlayers || players.length > RULES.maxPlayers) {
    throw new EngineError('invalid_setup', `players must be between ${RULES.minPlayers} and ${RULES.maxPlayers}`);
  }
  players.forEach((p, i) => {
    const nameOk = typeof p?.name === 'string' && p.name.trim() !== '';
    const colorOk = typeof p?.color === 'string' && p.color.trim() !== '';
    if (!nameOk || !colorOk) throw new EngineError('invalid_setup', `player ${i} needs a name and a color`);
  });
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new EngineError('invalid_setup', 'seed must be a finite number');
  }

  let rngState = Math.floor(seed) >>> 0;
  const openingRolls: OpeningRoll[] = [];

  // Highest total starts, then descending. Tied players re-throw among themselves only.
  const orderGroup = (group: number[], round: number): number[] => {
    if (group.length <= 1) return group;
    if (round > MAX_OPENING_ROUNDS) {
      throw new EngineError('invalid_setup', 'opening rolls did not resolve ties');
    }
    const byTotal = new Map<number, number[]>();
    for (const playerId of group) {
      const r = rollDice(rngState);
      rngState = r.state;
      const total = r.dice[0] + r.dice[1];
      openingRolls.push({ round, playerId, dice: r.dice, total });
      const list = byTotal.get(total) ?? [];
      list.push(playerId);
      byTotal.set(total, list);
    }
    const ordered: number[] = [];
    for (const total of [...byTotal.keys()].sort((a, b) => b - a)) {
      ordered.push(...orderGroup(byTotal.get(total) as number[], round + 1));
    }
    return ordered;
  };

  const turnOrder = orderGroup(
    players.map((_, i) => i),
    1,
  );

  return {
    version: 1,
    rngState,
    players: players.map(
      (p, i): PlayerState => ({
        id: i,
        name: p.name.trim(),
        color: p.color.trim(),
        position: 0,
        cash: RULES.startingCash,
        bankDebt: 0,
        utilities: [],
        vouchers: emptyVouchers(),
      }),
    ),
    turnOrder,
    turnIndex: 0,
    phase: 'awaiting_roll',
    pending: null,
    owners: {},
    levels: {},
    stations: {},
    mortgaged: {},
    developmentPaid: {},
    leaseOffers: {},
    leases: {},
    lastRoll: null,
    openingRolls,
  };
}

// ---------------------------------------------------------------------------
// Rule checks shared by getLegalActions (what the UI offers) and applyAction (what is enforced)
// ---------------------------------------------------------------------------

interface Problem {
  code: EngineErrorCode;
  message: string;
}

function propertyTargetProblem(board: Board, tile: number): Problem | null {
  if (!Number.isInteger(tile) || tile < 0 || tile >= board.tiles.length || board.tiles[tile].kind !== 'property') {
    return { code: 'invalid_target', message: `tile ${String(tile)} is not a property` };
  }
  return null;
}

function developmentProblem(board: Board, s: GameState, playerId: number, tile: number): Problem | null {
  const bad = propertyTargetProblem(board, tile);
  if (bad) return bad;
  if (s.owners[tile] !== playerId) {
    return { code: 'not_allowed', message: 'only the owner can develop a property' };
  }
  if (s.mortgaged[tile] !== undefined) {
    return { code: 'not_allowed', message: 'a mortgaged property cannot be developed' };
  }
  const district = board.tiles[tile].district as District;
  if (!ownsFullDistrict(board, s, playerId, district)) {
    return { code: 'not_allowed', message: `development needs all the properties of the ${district} district` };
  }
  if (levelOf(s, tile) >= RULES.maxLevel) {
    return { code: 'not_allowed', message: 'the property is already at the highest level' };
  }
  const cost = developmentStepCost(board, s, playerId, tile);
  if (s.players[playerId].cash < cost) {
    return { code: 'insufficient_cash', message: `needs ${cost}, has ${s.players[playerId].cash}` };
  }
  return null;
}

function stationProblem(
  board: Board,
  s: GameState,
  playerId: number,
  tile: number,
  viaOffice: boolean,
): Problem | null {
  const bad = propertyTargetProblem(board, tile);
  if (bad) return bad;
  if (s.owners[tile] !== playerId) {
    return { code: 'not_allowed', message: 'only the owner can build a station on a property' };
  }
  if (s.mortgaged[tile] !== undefined) {
    return { code: 'not_allowed', message: 'a station cannot be built on a mortgaged property' };
  }
  if (s.stations[tile] !== undefined) {
    return { code: 'not_allowed', message: 'this property already has a station' };
  }
  const cost = stationBuildCost(board, s, playerId, tile, viaOffice);
  if (s.players[playerId].cash < cost) {
    return { code: 'insufficient_cash', message: `needs ${cost}, has ${s.players[playerId].cash}` };
  }
  return null;
}

function mortgageProblem(board: Board, s: GameState, playerId: number, tile: number): Problem | null {
  const bad = propertyTargetProblem(board, tile);
  if (bad) return bad;
  if (s.owners[tile] !== playerId) {
    return { code: 'not_allowed', message: 'only the owner can mortgage a property' };
  }
  if (s.mortgaged[tile] !== undefined) {
    return { code: 'not_allowed', message: 'this property is already mortgaged' };
  }
  if (s.leases[tile] !== undefined) {
    return { code: 'not_allowed', message: 'a leased property cannot be mortgaged; end the lease first' };
  }
  if (s.leaseOffers[tile] !== undefined) {
    return { code: 'not_allowed', message: 'a property offered for rent cannot be mortgaged; cancel the listing first' };
  }
  return null;
}

function redeemProblem(board: Board, s: GameState, playerId: number, tile: number): Problem | null {
  const bad = propertyTargetProblem(board, tile);
  if (bad) return bad;
  if (s.owners[tile] !== playerId) {
    return { code: 'not_allowed', message: 'only the owner can redeem a property' };
  }
  const amount = s.mortgaged[tile];
  if (amount === undefined) {
    return { code: 'not_allowed', message: 'this property is not mortgaged' };
  }
  if (s.players[playerId].cash < amount) {
    return { code: 'insufficient_cash', message: `needs ${amount}, has ${s.players[playerId].cash}` };
  }
  return null;
}

function listProblem(board: Board, s: GameState, playerId: number, tile: number, laps: number | null): Problem | null {
  const bad = propertyTargetProblem(board, tile);
  if (bad) return bad;
  if (s.owners[tile] !== playerId) {
    return { code: 'not_allowed', message: 'only the owner can offer a property for rent' };
  }
  if (laps !== null && (!Number.isInteger(laps) || laps < 1)) {
    return { code: 'invalid_terms', message: 'laps must be a whole number of at least 1, or null for open-ended' };
  }
  if (s.mortgaged[tile] !== undefined) {
    return { code: 'not_allowed', message: 'a mortgaged property cannot be offered for rent' };
  }
  if (s.leases[tile] !== undefined) {
    return { code: 'not_allowed', message: 'this property is already leased' };
  }
  if (s.leaseOffers[tile] !== undefined) {
    return { code: 'not_allowed', message: 'this property is already offered for rent' };
  }
  return null;
}

function cancelListingProblem(board: Board, s: GameState, playerId: number, tile: number): Problem | null {
  const bad = propertyTargetProblem(board, tile);
  if (bad) return bad;
  if (s.owners[tile] !== playerId) {
    return { code: 'not_allowed', message: 'only the owner can cancel a listing' };
  }
  if (s.leaseOffers[tile] === undefined) {
    return { code: 'not_allowed', message: 'this property is not offered for rent' };
  }
  return null;
}

function rentProblem(board: Board, s: GameState, playerId: number, tile: number): Problem | null {
  const bad = propertyTargetProblem(board, tile);
  if (bad) return bad;
  if (s.leaseOffers[tile] === undefined) {
    return { code: 'not_allowed', message: 'this property is not offered for rent' };
  }
  if (s.owners[tile] === playerId) {
    return { code: 'not_allowed', message: 'you cannot rent your own property' };
  }
  return null;
}

function endLeaseProblem(board: Board, s: GameState, playerId: number, tile: number): Problem | null {
  const bad = propertyTargetProblem(board, tile);
  if (bad) return bad;
  if (s.owners[tile] !== playerId) {
    return { code: 'not_allowed', message: 'only the owner can end a lease' };
  }
  if (s.leases[tile] === undefined) {
    return { code: 'not_allowed', message: 'this property is not leased' };
  }
  return null;
}

// The owner may offer, cancel and end leases during his own turn, when no decision is pending.
const OWNER_MENU_PHASES: readonly Phase[] = ['awaiting_roll', 'awaiting_end_turn', 'in_office'];

function requireOwnerMenu(s: GameState): void {
  if (!OWNER_MENU_PHASES.includes(s.phase)) {
    throw new EngineError('invalid_phase', `action not allowed now (phase is ${s.phase})`);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** What the UI may offer right now. Empty means nothing can happen (phase 'insolvent'). */
export function getLegalActions(board: Board, state: GameState): Action[] {
  const actions = phaseActions(board, state);
  const me = currentPlayerId(state);
  if (OWNER_MENU_PHASES.includes(state.phase)) {
    for (let tile = 0; tile < board.tiles.length; tile++) {
      if (state.owners[tile] !== me) continue;
      // Listing takes free terms; the open-ended listing is offered as the representative action.
      if (listProblem(board, state, me, tile, null) === null) {
        actions.push({ type: 'LIST_FOR_RENT', playerId: me, tile, laps: null });
      }
      if (cancelListingProblem(board, state, me, tile) === null) actions.push({ type: 'CANCEL_LISTING', playerId: me, tile });
      if (endLeaseProblem(board, state, me, tile) === null) actions.push({ type: 'END_LEASE', playerId: me, tile });
    }
  }
  if (state.phase === 'in_office') {
    for (let tile = 0; tile < board.tiles.length; tile++) {
      if (rentProblem(board, state, me, tile) === null) actions.push({ type: 'RENT', playerId: me, tile });
    }
  }
  return actions;
}

function phaseActions(board: Board, state: GameState): Action[] {
  const me = currentPlayerId(state);
  const pending = state.pending;
  switch (state.phase) {
    case 'awaiting_roll':
      return [{ type: 'ROLL', playerId: me }];
    case 'awaiting_purchase': {
      if (!pending || pending.type !== 'purchase') return [];
      const actions: Action[] = [];
      if (state.players[me].cash >= pending.price) actions.push({ type: 'BUY', playerId: me });
      actions.push({ type: 'DECLINE_PURCHASE', playerId: me });
      return actions;
    }
    case 'awaiting_utility': {
      if (!pending || pending.type !== 'utility') return [];
      const actions: Action[] = [];
      if (state.players[me].cash >= pending.cost) actions.push({ type: 'ACTIVATE_UTILITY', playerId: me });
      actions.push({ type: 'SKIP_UTILITY', playerId: me });
      return actions;
    }
    case 'awaiting_fee_decision': {
      if (!pending || pending.type !== 'fee') return [];
      return [
        { type: 'COLLECT_FEE', playerId: pending.owner },
        { type: 'WAIVE_FEE', playerId: pending.owner },
      ];
    }
    case 'awaiting_end_turn': {
      const actions: Action[] = [];
      // A station may be built on an owned property you are standing on (just landed or just bought).
      const here = state.players[me].position;
      if (stationProblem(board, state, me, here, false) === null) {
        actions.push({ type: 'BUILD_STATION', playerId: me, tile: here });
      }
      actions.push({ type: 'END_TURN', playerId: me });
      return actions;
    }
    case 'in_office': {
      const actions: Action[] = [];
      for (let tile = 0; tile < board.tiles.length; tile++) {
        if (state.owners[tile] !== me) continue;
        if (developmentProblem(board, state, me, tile) === null) actions.push({ type: 'DEVELOP', playerId: me, tile });
        if (stationProblem(board, state, me, tile, true) === null) actions.push({ type: 'BUILD_STATION', playerId: me, tile });
        if (mortgageProblem(board, state, me, tile) === null) actions.push({ type: 'MORTGAGE', playerId: me, tile });
        if (redeemProblem(board, state, me, tile) === null) actions.push({ type: 'REDEEM', playerId: me, tile });
      }
      actions.push({ type: 'LEAVE_OFFICE', playerId: me });
      return actions;
    }
    case 'insolvent':
      return [];
  }
}

/**
 * Pure: never mutates `state`. Throws EngineError when the action is not allowed
 * (wrong phase, wrong player, not enough cash, malformed action).
 */
export function applyAction(board: Board, state: GameState, action: Action): StepResult {
  if (typeof action !== 'object' || action === null || !Number.isInteger(action.playerId)) {
    throw new EngineError('unknown_action', 'action must be an object with an integer playerId');
  }
  const s = clone(state);
  const events: GameEvent[] = [];

  switch (action.type) {
    case 'ROLL':
      doRoll(board, s, action.playerId, events);
      break;
    case 'BUY':
      doBuy(board, s, action.playerId, events);
      break;
    case 'DECLINE_PURCHASE':
      doDeclinePurchase(s, action.playerId, events);
      break;
    case 'COLLECT_FEE':
      doCollectFee(s, action.playerId, events);
      break;
    case 'WAIVE_FEE':
      doWaiveFee(s, action.playerId, events);
      break;
    case 'ACTIVATE_UTILITY':
      doActivateUtility(s, action.playerId, events);
      break;
    case 'SKIP_UTILITY':
      doSkipUtility(s, action.playerId, events);
      break;
    case 'DEVELOP':
      doDevelop(board, s, action.playerId, action.tile, events);
      break;
    case 'BUILD_STATION':
      doBuildStation(board, s, action.playerId, action.tile, events);
      break;
    case 'MORTGAGE':
      doMortgage(board, s, action.playerId, action.tile, events);
      break;
    case 'REDEEM':
      doRedeem(board, s, action.playerId, action.tile, events);
      break;
    case 'LIST_FOR_RENT':
      doListForRent(board, s, action.playerId, action.tile, action.laps, events);
      break;
    case 'CANCEL_LISTING':
      doCancelListing(board, s, action.playerId, action.tile, events);
      break;
    case 'RENT':
      doRent(board, s, action.playerId, action.tile, events);
      break;
    case 'END_LEASE':
      doEndLease(board, s, action.playerId, action.tile, events);
      break;
    case 'LEAVE_OFFICE':
      doLeaveOffice(s, action.playerId, events);
      break;
    case 'END_TURN':
      doEndTurn(s, action.playerId, events);
      break;
    default:
      throw new EngineError('unknown_action', `unknown action type ${String((action as { type: unknown }).type)}`);
  }
  return { state: s, events };
}

function requirePhase(s: GameState, phase: Phase): void {
  if (s.phase !== phase) {
    throw new EngineError('invalid_phase', `action not allowed now (phase is ${s.phase}, needs ${phase})`);
  }
}

function requireCurrentPlayer(s: GameState, playerId: number): PlayerState {
  if (playerId !== currentPlayerId(s)) {
    throw new EngineError('wrong_player', `it is player ${currentPlayerId(s)}'s turn, not player ${playerId}'s`);
  }
  return s.players[playerId];
}

function requirePending<T extends Pending['type']>(s: GameState, type: T): Extract<Pending, { type: T }> {
  const pending = s.pending;
  if (!pending || pending.type !== type) {
    throw new EngineError('invalid_phase', `no pending ${type} to resolve`);
  }
  return pending as Extract<Pending, { type: T }>;
}

function doRoll(board: Board, s: GameState, playerId: number, events: GameEvent[]): void {
  requirePhase(s, 'awaiting_roll');
  const player = requireCurrentPlayer(s, playerId);

  const r = rollDice(s.rngState);
  s.rngState = r.state;
  s.lastRoll = r.dice;
  const total = r.dice[0] + r.dice[1];
  events.push({ type: 'rolled', playerId, dice: r.dice, total });

  // Doubles grant nothing extra.
  moveForward(board, s, player, total, events, 0);
}

/**
 * Moves the player `steps` tiles clockwise (= increasing index), then resolves the landing.
 * Used by the dice and by cards that move the player; passing the gate counts either way.
 * `depth` is 0 for the dice and above 0 for a move caused by a card.
 */
function moveForward(
  board: Board,
  s: GameState,
  player: PlayerState,
  steps: number,
  events: GameEvent[],
  depth: number,
): void {
  const from = player.position;
  const raw = from + steps;
  const tileCount = board.tiles.length;
  const to = raw % tileCount;
  player.position = to;
  events.push({ type: 'moved', playerId: player.id, from, to });

  // Passing the gate, or arriving on it after a full lap, pays once. Starting a turn on it pays nothing.
  if (raw >= tileCount) {
    awardGateBonus(player, events);
    // Rent on every property the player leases falls due on completing a lap.
    if (!payRents(board, s, player, events)) return;
  }

  resolveLanding(board, s, player, events, depth);
}

function awardGateBonus(player: PlayerState, events: GameEvent[]): void {
  const bonus = RULES.gateBonus;
  const debtPaid = Math.min(player.bankDebt, bonus);
  player.bankDebt -= debtPaid;
  const received = bonus - debtPaid;
  player.cash += received;
  events.push({ type: 'gate_bonus', playerId: player.id, bonus, debtPaid, received });

  // Luck card "pass ticket": +300 on the first pass of the gate after drawing it.
  if (player.vouchers.gate_ticket > 0) {
    player.vouchers.gate_ticket -= 1;
    player.cash += RULES.gateTicketAmount;
    events.push({ type: 'voucher_used', playerId: player.id, voucher: 'gate_ticket', amount: RULES.gateTicketAmount });
    events.push({ type: 'bank_transfer', playerId: player.id, amount: RULES.gateTicketAmount, reason: 'gate_ticket' });
  }
}

// Only the tile where movement ends is activated; tiles passed over do nothing.
function resolveLanding(board: Board, s: GameState, player: PlayerState, events: GameEvent[], depth: number): void {
  const tileIndex = player.position;
  const tile = board.tiles[tileIndex];
  events.push({ type: 'landed', playerId: player.id, tile: tileIndex });

  if (tile.kind === 'gate') {
    s.phase = 'awaiting_end_turn';
    return;
  }

  if (tile.kind === 'property') {
    const owner: number | undefined = s.owners[tileIndex];
    if (owner === undefined) {
      const price = purchaseCost(board, s, player.id, tileIndex);
      s.pending = { type: 'purchase', tile: tileIndex, price };
      s.phase = 'awaiting_purchase';
    } else if (owner === player.id) {
      s.phase = 'awaiting_end_turn';
    } else if (s.mortgaged[tileIndex] !== undefined) {
      // A mortgaged property charges no landing fee.
      events.push({ type: 'no_fee_mortgaged', payer: player.id, owner, tile: tileIndex });
      s.phase = 'awaiting_end_turn';
    } else {
      // While leased, the landing fee goes to the tenant (who pays the owner rent each lap).
      const recipient = s.leases[tileIndex]?.tenant ?? owner;
      if (recipient === player.id) {
        // The tenant standing on the property he rents pays nothing.
        s.phase = 'awaiting_end_turn';
      } else {
        // Fee depends on development level and on a station (economy.ts). Its receiver may waive it.
        const amount = landingFee(board, s, tileIndex);
        if (player.vouchers.fee_exemption_active > 0) {
          // Luck card "no bills day": the first fee owed this turn is waived.
          player.vouchers.fee_exemption_active -= 1;
          events.push({ type: 'fee_exempted', payer: player.id, owner: recipient, tile: tileIndex, amount });
          s.phase = 'awaiting_end_turn';
        } else {
          s.pending = { type: 'fee', tile: tileIndex, payer: player.id, owner: recipient, amount };
          s.phase = 'awaiting_fee_decision';
          events.push({ type: 'fee_due', payer: player.id, owner: recipient, tile: tileIndex, amount });
        }
      }
    }
    return;
  }

  if (tile.kind === 'real_estate_office') {
    // Development, stations, mortgage and rent happen here. Sales join in a later phase.
    s.phase = 'in_office';
    events.push({ type: 'office_entered', playerId: player.id });
    return;
  }

  if (tile.kind === 'utility') {
    if (player.utilities.includes(tileIndex)) {
      // Activated: the park pays every time it is used; the other utilities work through discounts.
      s.phase = 'awaiting_end_turn';
      if (tile.district === 'residential') {
        player.cash += RULES.parkBonus;
        events.push({ type: 'utility_used', playerId: player.id, tile: tileIndex, amount: RULES.parkBonus });
        events.push({ type: 'bank_transfer', playerId: player.id, amount: RULES.parkBonus, reason: 'park' });
      }
    } else {
      s.pending = { type: 'utility', tile: tileIndex, cost: RULES.utilityActivationCost };
      s.phase = 'awaiting_utility';
    }
    return;
  }

  if (tile.kind === 'luck_or_mystery') {
    // A card never sends the player to another card tile in a chain: a card move that ends here does nothing.
    s.phase = 'awaiting_end_turn';
    if (depth === 0) drawCard(board, s, player, events);
    return;
  }

  // Municipality, financial center, transport center and city projects arrive in later phases.
  // Landing on them does nothing yet.
  events.push({ type: 'tile_not_implemented', playerId: player.id, tile: tileIndex, kind: tile.kind });
  s.phase = 'awaiting_end_turn';
}

// ---------------------------------------------------------------------------
// Cards (brief sections 12 and 13). The deck is random with replacement: every draw can be any card.
// ---------------------------------------------------------------------------

function drawCard(board: Board, s: GameState, player: PlayerState, events: GameEvent[]): void {
  const [pick, rng1] = nextFloat(s.rngState);
  const [index, rng2] = nextFloat(rng1);
  s.rngState = rng2;
  const fromLuck = pick * 100 < RULES.luckDeckChancePercent;
  if (fromLuck) {
    const card = board.luckCards[Math.floor(index * board.luckCards.length)];
    events.push({ type: 'card_drawn', playerId: player.id, deck: 'luck', cardId: card.id });
    applyLuckEffect(s, player, card.id, card.effect, events);
  } else {
    const card = board.mysteryCards[Math.floor(index * board.mysteryCards.length)];
    events.push({ type: 'card_drawn', playerId: player.id, deck: 'mystery', cardId: card.id });
    applyMysteryEffect(board, s, player, card.id, card.effect, events);
  }
}

function giveVoucher(player: PlayerState, voucher: VoucherKind, events: GameEvent[]): void {
  player.vouchers[voucher] += 1;
  events.push({ type: 'voucher_gained', playerId: player.id, voucher });
}

function applyLuckEffect(
  s: GameState,
  player: PlayerState,
  cardId: string,
  effect: LuckEffect,
  events: GameEvent[],
): void {
  switch (effect.type) {
    case 'gain':
      gainFromBank(player, effect.amount, cardId, events);
      return;
    case 'gain_if_owns_property': {
      const ownsOne = Object.values(s.owners).some((owner) => owner === player.id);
      gainFromBank(player, ownsOne ? effect.amount : effect.otherwise, cardId, events);
      return;
    }
    case 'pay':
      payBankByCard(s, player, effect.amount, cardId, events);
      return;
    case 'voucher':
      // "No bills day" is armed now and becomes active at the start of the player's next turn.
      giveVoucher(player, effect.voucher === 'fee_exemption' ? 'fee_exemption_armed' : effect.voucher, events);
      return;
  }
}

function gainFromBank(player: PlayerState, amount: number, reason: string, events: GameEvent[]): void {
  player.cash += amount;
  events.push({ type: 'bank_transfer', playerId: player.id, amount, reason });
}

/** A luck card orders the player to pay the bank. The "municipal exemption" voucher waives the first such amount. */
function payBankByCard(s: GameState, player: PlayerState, amount: number, cardId: string, events: GameEvent[]): void {
  if (player.vouchers.card_payment_exemption > 0) {
    player.vouchers.card_payment_exemption -= 1;
    events.push({ type: 'voucher_used', playerId: player.id, voucher: 'card_payment_exemption', amount });
    return;
  }
  if (player.cash >= amount) {
    player.cash -= amount;
    events.push({ type: 'bank_transfer', playerId: player.id, amount: -amount, reason: cardId });
    return;
  }
  // Cannot pay: nothing moves and the game halts until the insolvency rules arrive (phase 4).
  s.pending = { type: 'insolvent', cause: 'card', tile: player.position, payer: player.id, creditor: 'bank', amount };
  s.phase = 'insolvent';
  events.push({
    type: 'insolvent',
    cause: 'card',
    payer: player.id,
    creditor: 'bank',
    tile: player.position,
    amount,
  });
}

function applyMysteryEffect(
  board: Board,
  s: GameState,
  player: PlayerState,
  cardId: string,
  effect: MysteryEffect,
  events: GameEvent[],
): void {
  switch (effect.type) {
    case 'extra_roll':
      // One more throw and one more move, not a whole extra turn.
      s.phase = 'awaiting_roll';
      return;
    case 'move_to_nearest':
      moveToNearest(board, s, player, effect.kind, events);
      return;
    case 'voucher':
      giveVoucher(player, effect.voucher, events);
      return;
    case 'market_report':
      events.push({
        type: 'market_report',
        playerId: player.id,
        rentListings: Object.keys(s.leaseOffers)
          .map(Number)
          .sort((a, b) => a - b),
      });
      return;
    case 'not_implemented':
      events.push({ type: 'card_not_implemented', playerId: player.id, cardId });
      return;
  }
}

/** Moves clockwise to the nearest tile of that kind ahead of the player and activates it. */
function moveToNearest(board: Board, s: GameState, player: PlayerState, kind: TileKind, events: GameEvent[]): void {
  const tileCount = board.tiles.length;
  for (let distance = 1; distance <= tileCount; distance++) {
    if (board.tiles[(player.position + distance) % tileCount].kind === kind) {
      moveForward(board, s, player, distance, events, 1);
      return;
    }
  }
}

function doActivateUtility(s: GameState, playerId: number, events: GameEvent[]): void {
  requirePhase(s, 'awaiting_utility');
  const player = requireCurrentPlayer(s, playerId);
  const pending = requirePending(s, 'utility');
  if (player.cash < pending.cost) {
    throw new EngineError('insufficient_cash', `needs ${pending.cost}, has ${player.cash}`);
  }
  player.cash -= pending.cost;
  player.utilities.push(pending.tile);
  events.push({ type: 'bank_transfer', playerId, amount: -pending.cost, reason: 'utility_activation' });
  events.push({ type: 'utility_activated', playerId, tile: pending.tile });
  s.pending = null;
  s.phase = 'awaiting_end_turn';
}

function doSkipUtility(s: GameState, playerId: number, events: GameEvent[]): void {
  requirePhase(s, 'awaiting_utility');
  requireCurrentPlayer(s, playerId);
  const pending = requirePending(s, 'utility');
  events.push({ type: 'utility_skipped', playerId, tile: pending.tile });
  s.pending = null;
  s.phase = 'awaiting_end_turn';
}

function doBuy(board: Board, s: GameState, playerId: number, events: GameEvent[]): void {
  requirePhase(s, 'awaiting_purchase');
  const player = requireCurrentPlayer(s, playerId);
  const pending = requirePending(s, 'purchase');
  if (player.cash < pending.price) {
    throw new EngineError('insufficient_cash', `needs ${pending.price}, has ${player.cash}`);
  }
  player.cash -= pending.price;
  s.owners[pending.tile] = playerId;
  events.push({ type: 'bought', playerId, tile: pending.tile, price: pending.price });
  const withoutVoucher = purchaseCost(board, s, playerId, pending.tile, false);
  const shopping = propertyPrice(board, pending.tile) - withoutVoucher;
  if (shopping > 0) events.push({ type: 'utility_used', playerId, tile: pending.tile, amount: shopping });
  if (player.vouchers.purchase_discount > 0) {
    player.vouchers.purchase_discount -= 1;
    events.push({ type: 'voucher_used', playerId, voucher: 'purchase_discount', amount: withoutVoucher - pending.price });
  }
  s.pending = null;
  s.phase = 'awaiting_end_turn';
}

function doDeclinePurchase(s: GameState, playerId: number, events: GameEvent[]): void {
  requirePhase(s, 'awaiting_purchase');
  requireCurrentPlayer(s, playerId);
  const pending = requirePending(s, 'purchase');
  // The property stays unowned and available to whoever lands on it next.
  events.push({ type: 'purchase_declined', playerId, tile: pending.tile });
  s.pending = null;
  s.phase = 'awaiting_end_turn';
}

function requireFeeOwner(s: GameState, playerId: number): Extract<Pending, { type: 'fee' }> {
  requirePhase(s, 'awaiting_fee_decision');
  const pending = requirePending(s, 'fee');
  if (playerId !== pending.owner) {
    throw new EngineError('wrong_player', `only the owner (player ${pending.owner}) decides on the fee`);
  }
  return pending;
}

function doCollectFee(s: GameState, playerId: number, events: GameEvent[]): void {
  const pending = requireFeeOwner(s, playerId);
  const payer = s.players[pending.payer];
  const owner = s.players[pending.owner];

  if (payer.cash >= pending.amount) {
    payer.cash -= pending.amount;
    owner.cash += pending.amount;
    events.push({
      type: 'fee_paid',
      payer: pending.payer,
      owner: pending.owner,
      tile: pending.tile,
      amount: pending.amount,
    });
    s.pending = null;
    s.phase = 'awaiting_end_turn';
    return;
  }

  // The payer cannot cover the fee. Nothing moves; the insolvency procedure (brief section 11)
  // is implemented in phase 4, so the game halts in this phase until then.
  s.pending = {
    type: 'insolvent',
    cause: 'fee',
    tile: pending.tile,
    payer: pending.payer,
    creditor: pending.owner,
    amount: pending.amount,
  };
  s.phase = 'insolvent';
  events.push({
    type: 'insolvent',
    cause: 'fee',
    payer: pending.payer,
    creditor: pending.owner,
    tile: pending.tile,
    amount: pending.amount,
  });
}

function doWaiveFee(s: GameState, playerId: number, events: GameEvent[]): void {
  const pending = requireFeeOwner(s, playerId);
  events.push({
    type: 'fee_waived',
    payer: pending.payer,
    owner: pending.owner,
    tile: pending.tile,
    amount: pending.amount,
  });
  s.pending = null;
  s.phase = 'awaiting_end_turn';
}

function doDevelop(board: Board, s: GameState, playerId: number, tile: number, events: GameEvent[]): void {
  requirePhase(s, 'in_office');
  const player = requireCurrentPlayer(s, playerId);
  const problem = developmentProblem(board, s, playerId, tile);
  if (problem) throw new EngineError(problem.code, problem.message);

  const cost = developmentStepCost(board, s, playerId, tile);
  const level = (levelOf(s, tile) + 1) as 2 | 3;
  if (player.vouchers.development_discount > 0) {
    player.vouchers.development_discount -= 1;
    const amount = developmentStepCost(board, s, playerId, tile, false) - cost;
    events.push({ type: 'voucher_used', playerId, voucher: 'development_discount', amount });
  }
  player.cash -= cost;
  s.levels[tile] = level;
  s.developmentPaid[tile] = developmentPaid(s, tile) + cost;
  events.push({ type: 'developed', playerId, tile, level, cost });
}

function doBuildStation(board: Board, s: GameState, playerId: number, tile: number, events: GameEvent[]): void {
  if (s.phase !== 'in_office' && s.phase !== 'awaiting_end_turn') {
    throw new EngineError('invalid_phase', `action not allowed now (phase is ${s.phase})`);
  }
  const player = requireCurrentPlayer(s, playerId);
  // Outside the office, only the property the player is standing on qualifies.
  if (s.phase === 'awaiting_end_turn' && tile !== player.position) {
    throw new EngineError('not_allowed', 'outside the office a station can only be built where you stand');
  }
  const viaOffice = s.phase === 'in_office';
  const problem = stationProblem(board, s, playerId, tile, viaOffice);
  if (problem) throw new EngineError(problem.code, problem.message);

  const cost = stationBuildCost(board, s, playerId, tile, viaOffice);
  if (viaOffice && player.vouchers.station_discount > 0) {
    player.vouchers.station_discount -= 1;
    const amount = stationBuildCost(board, s, playerId, tile, viaOffice, false) - cost;
    events.push({ type: 'voucher_used', playerId, voucher: 'station_discount', amount });
  }
  const district = board.tiles[tile].district as District;
  if (hasUtility(board, player, district) && (district === 'tech' || district === 'industrial')) {
    const full = stationBuildCost(board, s, playerId, tile, viaOffice, false);
    events.push({ type: 'utility_used', playerId, tile, amount: stationCost(propertyPrice(board, tile)) - full });
  }
  player.cash -= cost;
  s.stations[tile] = playerId;
  events.push({ type: 'station_built', playerId, tile, cost });
}

function doMortgage(board: Board, s: GameState, playerId: number, tile: number, events: GameEvent[]): void {
  requirePhase(s, 'in_office');
  const player = requireCurrentPlayer(s, playerId);
  const problem = mortgageProblem(board, s, playerId, tile);
  if (problem) throw new EngineError(problem.code, problem.message);

  const amount = mortgageValue(board, s, tile);
  player.cash += amount;
  s.mortgaged[tile] = amount;
  events.push({ type: 'mortgaged', playerId, tile, amount });
}

function doRedeem(board: Board, s: GameState, playerId: number, tile: number, events: GameEvent[]): void {
  requirePhase(s, 'in_office');
  const player = requireCurrentPlayer(s, playerId);
  const problem = redeemProblem(board, s, playerId, tile);
  if (problem) throw new EngineError(problem.code, problem.message);

  const amount = s.mortgaged[tile];
  player.cash -= amount;
  delete s.mortgaged[tile];
  events.push({ type: 'redeemed', playerId, tile, amount });
}

function doListForRent(
  board: Board,
  s: GameState,
  playerId: number,
  tile: number,
  laps: number | null,
  events: GameEvent[],
): void {
  requireOwnerMenu(s);
  requireCurrentPlayer(s, playerId);
  const problem = listProblem(board, s, playerId, tile, laps === undefined ? Number.NaN : laps);
  if (problem) throw new EngineError(problem.code, problem.message);
  s.leaseOffers[tile] = { laps };
  events.push({ type: 'listed_for_rent', playerId, tile, laps });
}

function doCancelListing(board: Board, s: GameState, playerId: number, tile: number, events: GameEvent[]): void {
  requireOwnerMenu(s);
  requireCurrentPlayer(s, playerId);
  const problem = cancelListingProblem(board, s, playerId, tile);
  if (problem) throw new EngineError(problem.code, problem.message);
  delete s.leaseOffers[tile];
  events.push({ type: 'listing_cancelled', playerId, tile });
}

function doRent(board: Board, s: GameState, playerId: number, tile: number, events: GameEvent[]): void {
  requirePhase(s, 'in_office');
  requireCurrentPlayer(s, playerId);
  const problem = rentProblem(board, s, playerId, tile);
  if (problem) throw new EngineError(problem.code, problem.message);
  const laps = s.leaseOffers[tile].laps;
  delete s.leaseOffers[tile];
  s.leases[tile] = { tenant: playerId, lapsLeft: laps };
  events.push({ type: 'leased', tenant: playerId, owner: s.owners[tile], tile, laps });
}

function doEndLease(board: Board, s: GameState, playerId: number, tile: number, events: GameEvent[]): void {
  requireOwnerMenu(s);
  requireCurrentPlayer(s, playerId);
  const problem = endLeaseProblem(board, s, playerId, tile);
  if (problem) throw new EngineError(problem.code, problem.message);
  const tenant = s.leases[tile].tenant;
  delete s.leases[tile];
  events.push({ type: 'lease_ended', tile, owner: playerId, tenant, reason: 'owner' });
}

/**
 * On completing a lap the tenant pays 10% of the original price to the owner for every property
 * he leases (in tile order). Returns false when he cannot pay: nothing more moves, the phase becomes
 * 'insolvent' (rules arrive in phase 4) and the landing of this move stays unresolved.
 */
function payRents(board: Board, s: GameState, player: PlayerState, events: GameEvent[]): boolean {
  for (let tile = 0; tile < board.tiles.length; tile++) {
    const lease = s.leases[tile];
    if (!lease || lease.tenant !== player.id) continue;
    const owner = s.owners[tile];
    const amount = rentAmount(propertyPrice(board, tile));
    if (player.cash < amount) {
      s.pending = { type: 'insolvent', cause: 'rent', tile, payer: player.id, creditor: owner, amount };
      s.phase = 'insolvent';
      events.push({ type: 'insolvent', cause: 'rent', payer: player.id, creditor: owner, tile, amount });
      return false;
    }
    player.cash -= amount;
    s.players[owner].cash += amount;
    const lapsLeft = lease.lapsLeft === null ? null : lease.lapsLeft - 1;
    events.push({ type: 'rent_paid', tenant: player.id, owner, tile, amount, lapsLeft });
    if (lapsLeft === 0) {
      delete s.leases[tile];
      events.push({ type: 'lease_ended', tile, owner, tenant: player.id, reason: 'term' });
    } else {
      s.leases[tile] = { tenant: lease.tenant, lapsLeft };
    }
  }
  return true;
}

function doLeaveOffice(s: GameState, playerId: number, events: GameEvent[]): void {
  requirePhase(s, 'in_office');
  requireCurrentPlayer(s, playerId);
  events.push({ type: 'office_left', playerId });
  s.phase = 'awaiting_end_turn';
}

function doEndTurn(s: GameState, playerId: number, events: GameEvent[]): void {
  requirePhase(s, 'awaiting_end_turn');
  requireCurrentPlayer(s, playerId);
  events.push({ type: 'turn_ended', playerId });
  // "No bills day" lasts one turn only.
  s.players[playerId].vouchers.fee_exemption_active = 0;
  s.turnIndex = (s.turnIndex + 1) % s.turnOrder.length;
  const next = s.players[currentPlayerId(s)];
  next.vouchers.fee_exemption_active += next.vouchers.fee_exemption_armed;
  next.vouchers.fee_exemption_armed = 0;
  s.phase = 'awaiting_roll';
  s.pending = null;
  s.lastRoll = null;
  events.push({ type: 'turn_started', playerId: currentPlayerId(s) });
}

// ---------------------------------------------------------------------------
// Consistency check (used by tests and when loading saves)
// ---------------------------------------------------------------------------

/** Returns a list of broken invariants; an empty list means the state is consistent. */
export function checkInvariants(board: Board, state: GameState): string[] {
  const problems: string[] = [];
  try {
    if (state.version !== 1) problems.push(`unsupported state version ${String(state.version)}`);

    const tileCount = board.tiles.length;
    const count = state.players.length;
    if (count < RULES.minPlayers || count > RULES.maxPlayers) {
      problems.push(`player count ${count} is outside ${RULES.minPlayers}-${RULES.maxPlayers}`);
    }

    state.players.forEach((p, i) => {
      if (p.id !== i) problems.push(`player at index ${i} has id ${p.id}`);
      if (!Number.isInteger(p.cash) || p.cash < 0) problems.push(`player ${i} has invalid cash ${p.cash}`);
      if (!Number.isInteger(p.bankDebt) || p.bankDebt < 0) {
        problems.push(`player ${i} has invalid bank debt ${p.bankDebt}`);
      }
      if (!Number.isInteger(p.position) || p.position < 0 || p.position >= tileCount) {
        problems.push(`player ${i} has invalid position ${p.position}`);
      }
      for (const kind of VOUCHER_KINDS) {
        const n = p.vouchers?.[kind];
        if (!Number.isInteger(n) || n < 0) problems.push(`player ${i} has invalid ${kind} count ${String(n)}`);
      }
      if (new Set(p.utilities).size !== p.utilities.length) problems.push(`player ${i} lists a utility twice`);
      for (const tile of p.utilities) {
        if (board.tiles[tile]?.kind !== 'utility') problems.push(`player ${i} lists non-utility tile ${tile}`);
      }
    });

    const sortedOrder = [...state.turnOrder].sort((a, b) => a - b);
    if (sortedOrder.length !== count || sortedOrder.some((v, i) => v !== i)) {
      problems.push('turnOrder must be a permutation of the player ids');
    }
    if (!Number.isInteger(state.turnIndex) || state.turnIndex < 0 || state.turnIndex >= count) {
      problems.push(`invalid turnIndex ${state.turnIndex}`);
    }
    if (!Number.isInteger(state.rngState) || state.rngState < 0 || state.rngState > 4294967295) {
      problems.push(`invalid rngState ${state.rngState}`);
    }

    for (const [key, owner] of Object.entries(state.owners)) {
      const tile = board.tiles[Number(key)];
      if (!tile || tile.kind !== 'property') problems.push(`owners lists non-property tile ${key}`);
      if (!Number.isInteger(owner) || owner < 0 || owner >= count) {
        problems.push(`tile ${key} has invalid owner ${owner}`);
      }
    }

    for (const [key, level] of Object.entries(state.levels)) {
      const tile = board.tiles[Number(key)];
      if (!tile || tile.kind !== 'property' || state.owners[Number(key)] === undefined) {
        problems.push(`levels lists tile ${key}, which is not an owned property`);
      }
      if (level !== 2 && level !== 3) problems.push(`tile ${key} has invalid level ${String(level)}`);
    }
    for (const key of Object.keys(state.levels)) {
      if (state.developmentPaid[Number(key)] === undefined) problems.push(`developed tile ${key} has no development cost record`);
    }
    for (const [key, paid] of Object.entries(state.developmentPaid)) {
      if (state.levels[Number(key)] === undefined) problems.push(`developmentPaid lists undeveloped tile ${key}`);
      if (!Number.isInteger(paid) || paid < 0) problems.push(`tile ${key} has invalid development cost ${String(paid)}`);
    }
    for (const [key, owner] of Object.entries(state.stations)) {
      const tile = board.tiles[Number(key)];
      if (!tile || tile.kind !== 'property' || state.owners[Number(key)] === undefined) {
        problems.push(`stations lists tile ${key}, which is not an owned property`);
      } else if (owner !== state.owners[Number(key)]) {
        // Separate station ownership needs a landing-fee rule that is still undecided.
        problems.push(`station on tile ${key} must belong to the property owner`);
      }
    }

    for (const [key, amount] of Object.entries(state.mortgaged)) {
      const tile = board.tiles[Number(key)];
      if (!tile || tile.kind !== 'property' || state.owners[Number(key)] === undefined) {
        problems.push(`mortgaged lists tile ${key}, which is not an owned property`);
      }
      if (!Number.isInteger(amount) || amount <= 0) problems.push(`tile ${key} has invalid mortgage amount ${String(amount)}`);
    }

    for (const [key, offer] of Object.entries(state.leaseOffers)) {
      const tile = board.tiles[Number(key)];
      const k = Number(key);
      if (!tile || tile.kind !== 'property' || state.owners[k] === undefined) {
        problems.push(`leaseOffers lists tile ${key}, which is not an owned property`);
        continue;
      }
      if (state.mortgaged[k] !== undefined) problems.push(`tile ${key} is both mortgaged and offered for rent`);
      if (state.leases[k] !== undefined) problems.push(`tile ${key} is both leased and offered for rent`);
      if (offer.laps !== null && (!Number.isInteger(offer.laps) || offer.laps < 1)) {
        problems.push(`tile ${key} has invalid listing length ${String(offer.laps)}`);
      }
    }
    for (const [key, lease] of Object.entries(state.leases)) {
      const tile = board.tiles[Number(key)];
      const k = Number(key);
      if (!tile || tile.kind !== 'property' || state.owners[k] === undefined) {
        problems.push(`leases lists tile ${key}, which is not an owned property`);
        continue;
      }
      if (state.mortgaged[k] !== undefined) problems.push(`tile ${key} is both mortgaged and leased`);
      if (!Number.isInteger(lease.tenant) || lease.tenant < 0 || lease.tenant >= count) {
        problems.push(`tile ${key} has invalid tenant ${String(lease.tenant)}`);
      } else if (lease.tenant === state.owners[k]) {
        problems.push(`tile ${key} is leased to its own owner`);
      }
      if (lease.lapsLeft !== null && (!Number.isInteger(lease.lapsLeft) || lease.lapsLeft < 1)) {
        problems.push(`tile ${key} has invalid lease length ${String(lease.lapsLeft)}`);
      }
    }

    const pending = state.pending;
    const me = state.turnOrder[state.turnIndex];
    switch (state.phase) {
      case 'awaiting_roll':
      case 'awaiting_end_turn':
        if (pending !== null) problems.push(`phase ${state.phase} must not have a pending item`);
        break;
      case 'in_office':
        if (pending !== null) problems.push('in_office must not have a pending item');
        if (board.tiles[state.players[me].position]?.kind !== 'real_estate_office') {
          problems.push('in_office requires the current player to stand on the real estate office');
        }
        break;
      case 'awaiting_purchase': {
        if (!pending || pending.type !== 'purchase') {
          problems.push('awaiting_purchase needs a pending purchase');
          break;
        }
        const tile = board.tiles[pending.tile];
        if (!tile || tile.kind !== 'property' || purchaseCost(board, state, me, pending.tile) !== pending.price) {
          problems.push('pending purchase does not match its tile');
        }
        if (state.owners[pending.tile] !== undefined) problems.push('pending purchase is on an owned tile');
        if (state.players[me].position !== pending.tile) {
          problems.push('pending purchase is not on the current player position');
        }
        break;
      }
      case 'awaiting_fee_decision': {
        if (!pending || pending.type !== 'fee') {
          problems.push('awaiting_fee_decision needs a pending fee');
          break;
        }
        const tile = board.tiles[pending.tile];
        if (!tile || tile.kind !== 'property' || landingFee(board, state, pending.tile) !== pending.amount) {
          problems.push('pending fee does not match its tile');
        }
        // The fee goes to the tenant while the property is leased, otherwise to its owner.
        const receiver = state.leases[pending.tile]?.tenant ?? state.owners[pending.tile];
        if (receiver !== pending.owner) problems.push('pending fee receiver is neither the tenant nor the owner');
        if (state.owners[pending.tile] === pending.payer) problems.push('the owner never pays a fee on his own property');
        if (state.mortgaged[pending.tile] !== undefined) problems.push('pending fee is on a mortgaged tile');
        if (pending.payer !== me) problems.push('pending fee payer must be the current player');
        if (pending.payer === pending.owner) problems.push('pending fee payer and owner are the same player');
        break;
      }
      case 'awaiting_utility': {
        if (!pending || pending.type !== 'utility') {
          problems.push('awaiting_utility needs a pending utility');
          break;
        }
        if (board.tiles[pending.tile]?.kind !== 'utility') problems.push('pending utility is not on a utility tile');
        if (state.players[me].position !== pending.tile) problems.push('pending utility is not on the current player position');
        if (state.players[me].utilities.includes(pending.tile)) problems.push('pending utility is already activated');
        if (pending.cost !== RULES.utilityActivationCost) problems.push('pending utility has the wrong cost');
        break;
      }
      case 'insolvent':
        if (!pending || pending.type !== 'insolvent') {
          problems.push('insolvent phase needs a pending insolvency');
        } else if (pending.cause === 'card') {
          if (pending.creditor !== 'bank') problems.push('a card insolvency is owed to the bank');
        } else if (pending.cause === 'rent') {
          const lease = state.leases[pending.tile];
          if (!lease || lease.tenant !== pending.payer || state.owners[pending.tile] !== pending.creditor) {
            problems.push('pending rent insolvency does not match a lease');
          }
        }
        break;
      default:
        problems.push(`unknown phase ${String(state.phase)}`);
    }
  } catch (e) {
    problems.push(`state is malformed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return problems;
}
