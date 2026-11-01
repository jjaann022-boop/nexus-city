import { validateBoard } from './board.ts';
import {
  developmentCost,
  landingFee,
  levelOf,
  mortgageValue,
  ownsFullDistrict,
  propertyPrice,
  rentAmount,
  stationCost,
} from './economy.ts';
import { EngineError } from './errors.ts';
import type { EngineErrorCode } from './errors.ts';
import { rollDice } from './rng.ts';
import { RULES } from './rules.ts';
import type {
  Action,
  Board,
  District,
  GameEvent,
  GameState,
  OpeningRoll,
  Pending,
  Phase,
  PlayerSetup,
  PlayerState,
  StepResult,
} from './types.ts';

const MAX_OPENING_ROUNDS = 50;

// State is plain JSON, so a JSON round trip is a safe deep copy everywhere (browser, WebView, Node).
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
  const cost = developmentCost(propertyPrice(board, tile));
  if (s.players[playerId].cash < cost) {
    return { code: 'insufficient_cash', message: `needs ${cost}, has ${s.players[playerId].cash}` };
  }
  return null;
}

function stationProblem(board: Board, s: GameState, playerId: number, tile: number): Problem | null {
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
  const cost = stationCost(propertyPrice(board, tile));
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
      if (stationProblem(board, state, me, here) === null) {
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
        if (stationProblem(board, state, me, tile) === null) actions.push({ type: 'BUILD_STATION', playerId: me, tile });
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
      doBuy(s, action.playerId, events);
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

  // Doubles grant nothing extra. Movement is clockwise = increasing index.
  const from = player.position;
  const raw = from + total;
  const tileCount = board.tiles.length;
  const to = raw % tileCount;
  player.position = to;
  events.push({ type: 'moved', playerId, from, to });

  // Passing the gate, or arriving on it after a full lap, pays once. Starting a turn on it pays nothing.
  if (raw >= tileCount) {
    awardGateBonus(player, events);
    // Rent on every property the player leases falls due on completing a lap.
    if (!payRents(board, s, player, events)) return;
  }

  resolveLanding(board, s, player, events);
}

function awardGateBonus(player: PlayerState, events: GameEvent[]): void {
  const bonus = RULES.gateBonus;
  const debtPaid = Math.min(player.bankDebt, bonus);
  player.bankDebt -= debtPaid;
  const received = bonus - debtPaid;
  player.cash += received;
  events.push({ type: 'gate_bonus', playerId: player.id, bonus, debtPaid, received });
}

// Only the tile where movement ends is activated; tiles passed over do nothing.
function resolveLanding(board: Board, s: GameState, player: PlayerState, events: GameEvent[]): void {
  const tileIndex = player.position;
  const tile = board.tiles[tileIndex];
  events.push({ type: 'landed', playerId: player.id, tile: tileIndex });

  if (tile.kind === 'gate') {
    s.phase = 'awaiting_end_turn';
    return;
  }

  if (tile.kind === 'property') {
    const price = tile.price as number;
    const owner: number | undefined = s.owners[tileIndex];
    if (owner === undefined) {
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
        s.pending = { type: 'fee', tile: tileIndex, payer: player.id, owner: recipient, amount };
        s.phase = 'awaiting_fee_decision';
        events.push({ type: 'fee_due', payer: player.id, owner: recipient, tile: tileIndex, amount });
      }
    }
    return;
  }

  if (tile.kind === 'real_estate_office') {
    // Development and station building happen here. Mortgage, rent and sales join in later phases.
    s.phase = 'in_office';
    events.push({ type: 'office_entered', playerId: player.id });
    return;
  }

  // Municipality, financial center, transport center, utilities, projects and
  // luck/mystery tiles arrive in later phases. Landing on them does nothing yet.
  events.push({ type: 'tile_not_implemented', playerId: player.id, tile: tileIndex, kind: tile.kind });
  s.phase = 'awaiting_end_turn';
}

function doBuy(s: GameState, playerId: number, events: GameEvent[]): void {
  requirePhase(s, 'awaiting_purchase');
  const player = requireCurrentPlayer(s, playerId);
  const pending = requirePending(s, 'purchase');
  if (player.cash < pending.price) {
    throw new EngineError('insufficient_cash', `needs ${pending.price}, has ${player.cash}`);
  }
  player.cash -= pending.price;
  s.owners[pending.tile] = playerId;
  events.push({ type: 'bought', playerId, tile: pending.tile, price: pending.price });
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

  const cost = developmentCost(propertyPrice(board, tile));
  const level = (levelOf(s, tile) + 1) as 2 | 3;
  player.cash -= cost;
  s.levels[tile] = level;
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
  const problem = stationProblem(board, s, playerId, tile);
  if (problem) throw new EngineError(problem.code, problem.message);

  const cost = stationCost(propertyPrice(board, tile));
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
  s.turnIndex = (s.turnIndex + 1) % s.turnOrder.length;
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
        if (!tile || tile.kind !== 'property' || tile.price !== pending.price) {
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
      case 'insolvent':
        if (!pending || pending.type !== 'insolvent') {
          problems.push('insolvent phase needs a pending insolvency');
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
