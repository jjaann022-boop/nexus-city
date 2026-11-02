import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkInvariants, getLegalActions } from '../src/engine/engine.ts';
import { rentAmount } from '../src/engine/economy.ts';
import { deserializeGame, SaveError, serializeGame } from '../src/engine/save.ts';
import type { Action, GameEvent, GameState } from '../src/engine/types.ts';
import { act, board, deepFreeze, expectCode, forceRoll, newGame, patch, rollOnto, setLevel, totalIs } from './helpers.ts';

// Placeholder board: commercial properties are tiles 1,2,4,6,8 priced 600,700,800,900,1000.
const COMMERCIAL = [1, 2, 4, 6, 8];
const OFFICE = 36;
const [O, T, V] = [0, 1, 2]; // owner, tenant, visitor

/** Player O owns the commercial district; three players; it is O's turn. */
function world(): GameState {
  return asCurrent(
    patch(newGame(3), (d) => {
      for (const t of COMMERCIAL) d.owners[t] = O;
    }),
    O,
  );
}

function asCurrent(state: GameState, id: number): GameState {
  return patch(state, (d) => {
    d.turnIndex = d.turnOrder.indexOf(id);
    d.phase = 'awaiting_roll';
    d.pending = null;
    d.lastRoll = null;
  });
}

const leased = (state: GameState, tile: number, tenant: number, lapsLeft: number | null): GameState =>
  patch(state, (d) => void (d.leases[tile] = { tenant, lapsLeft }));

const withCash = (state: GameState, id: number, cash: number): GameState =>
  patch(state, (d) => void (d.players[id].cash = cash));

const kinds = (events: GameEvent[]): string[] => events.map((e) => e.type);

const legal = (state: GameState, type: Action['type']): number[] =>
  getLegalActions(board, state)
    .filter((a) => a.type === type)
    .map((a) => (a as { tile: number }).tile);

/** Player `id` completes a lap: starts on tile 30 and rolls 7, arriving exactly on the gate (tile 0). */
function completeLap(state: GameState, id: number): { state: GameState; events: GameEvent[] } {
  const ready = patch(forceRoll(asCurrent(state, id), totalIs(7)), (d) => void (d.players[id].position = 30));
  return act(ready, { type: 'ROLL', playerId: id });
}

/** Player `id` stands in the office. */
function inOffice(state: GameState, id: number): GameState {
  const s = rollOnto(asCurrent(state, id), OFFICE, 4).state;
  assert.equal(s.phase, 'in_office');
  return s;
}

describe('rent amount', () => {
  it('is 50% of the original price', () => {
    assert.equal(rentAmount(800), 400);
    assert.equal(rentAmount(1000), 500);
  });
});

describe('offering a property for rent', () => {
  it('the owner can do it during his own turn: before rolling, after moving, and in the office', () => {
    const start = world();
    const listed = act(start, { type: 'LIST_FOR_RENT', playerId: O, tile: 4, laps: 3 });
    assert.deepEqual(listed.state.leaseOffers[4], { laps: 3 });
    assert.deepEqual(listed.events, [{ type: 'listed_for_rent', playerId: O, tile: 4, laps: 3 }]);
    assert.equal(listed.state.phase, 'awaiting_roll', 'listing does not use up the turn');
    assert.deepEqual(checkInvariants(board, listed.state), []);

    const moved = rollOnto(start, 12, 4).state; // a luck/mystery tile: awaiting_end_turn
    assert.equal(moved.phase, 'awaiting_end_turn');
    assert.equal(act(moved, { type: 'LIST_FOR_RENT', playerId: O, tile: 4, laps: null }).state.leaseOffers[4].laps, null);

    const office = inOffice(start, O);
    assert.equal(act(office, { type: 'LIST_FOR_RENT', playerId: O, tile: 6, laps: 1 }).state.phase, 'in_office');
  });

  it('is only possible on his own turn', () => {
    const s = world();
    expectCode(() => act(s, { type: 'LIST_FOR_RENT', playerId: T, tile: 4, laps: 2 }), 'wrong_player');
    expectCode(() => act(s, { type: 'CANCEL_LISTING', playerId: T, tile: 4 }), 'wrong_player');
    expectCode(() => act(s, { type: 'END_LEASE', playerId: T, tile: 4 }), 'wrong_player');
  });

  it('is not possible while a decision is pending', () => {
    const buying = rollOnto(asCurrent(newGame(3), O), 4).state; // awaiting_purchase
    assert.equal(buying.phase, 'awaiting_purchase');
    const owned = patch(buying, (d) => void (d.owners[6] = O));
    expectCode(() => act(owned, { type: 'LIST_FOR_RENT', playerId: O, tile: 6, laps: 2 }), 'invalid_phase');

    const fee = rollOnto(patch(world(), (d) => void (d.owners[4] = V)), 4).state; // O must pay V
    assert.equal(fee.phase, 'awaiting_fee_decision');
    expectCode(() => act(fee, { type: 'LIST_FOR_RENT', playerId: O, tile: 6, laps: 2 }), 'invalid_phase');
  });

  it('needs whole-number lengths of at least 1, or null for open-ended', () => {
    const s = world();
    for (const laps of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', undefined]) {
      expectCode(
        () => act(s, { type: 'LIST_FOR_RENT', playerId: O, tile: 4, laps } as unknown as Action),
        'invalid_terms',
      );
    }
    for (const laps of [1, 2, 50, null]) assert.doesNotThrow(() => act(s, { type: 'LIST_FOR_RENT', playerId: O, tile: 4, laps }));
  });

  it('is refused for other targets, non-owners, mortgaged, already listed or leased properties', () => {
    const s = world();
    for (const tile of [0, 3, 5, 99, -1, 2.5]) {
      expectCode(() => act(s, { type: 'LIST_FOR_RENT', playerId: O, tile, laps: 2 }), 'invalid_target');
    }
    expectCode(() => act(s, { type: 'LIST_FOR_RENT', playerId: O, tile: 10, laps: 2 }), 'not_allowed'); // unowned
    const mortgaged = patch(s, (d) => void (d.mortgaged[4] = 800));
    expectCode(() => act(mortgaged, { type: 'LIST_FOR_RENT', playerId: O, tile: 4, laps: 2 }), 'not_allowed');
    const listed = act(s, { type: 'LIST_FOR_RENT', playerId: O, tile: 4, laps: 2 }).state;
    expectCode(() => act(listed, { type: 'LIST_FOR_RENT', playerId: O, tile: 4, laps: 5 }), 'not_allowed');
    expectCode(() => act(leased(s, 4, T, null), { type: 'LIST_FOR_RENT', playerId: O, tile: 4, laps: 2 }), 'not_allowed');
  });

  it('can be cancelled before anyone rents it', () => {
    const listed = act(world(), { type: 'LIST_FOR_RENT', playerId: O, tile: 4, laps: 2 }).state;
    assert.deepEqual(legal(listed, 'CANCEL_LISTING'), [4]);
    const { state, events } = act(listed, { type: 'CANCEL_LISTING', playerId: O, tile: 4 });
    assert.deepEqual(state.leaseOffers, {});
    assert.deepEqual(events, [{ type: 'listing_cancelled', playerId: O, tile: 4 }]);
    expectCode(() => act(state, { type: 'CANCEL_LISTING', playerId: O, tile: 4 }), 'not_allowed');
    expectCode(() => act(world(), { type: 'CANCEL_LISTING', playerId: O, tile: 10 }), 'not_allowed');
  });

  it('shows the owner the actions he can take', () => {
    const s = world();
    assert.deepEqual(legal(s, 'LIST_FOR_RENT'), COMMERCIAL);
    const listed = act(s, { type: 'LIST_FOR_RENT', playerId: O, tile: 2, laps: 2 }).state;
    assert.deepEqual(legal(listed, 'LIST_FOR_RENT'), [1, 4, 6, 8]);
    assert.deepEqual(legal(listed, 'CANCEL_LISTING'), [2]);
    const withLease = leased(s, 6, T, null);
    assert.deepEqual(legal(withLease, 'END_LEASE'), [6]);
    assert.deepEqual(legal(withLease, 'LIST_FOR_RENT'), [1, 2, 4, 8]);
    assert.deepEqual(legal(asCurrent(withLease, V), 'LIST_FOR_RENT'), [], 'a player who owns nothing has no menu');
  });
});

describe('renting a listed property', () => {
  function listedWorld(laps: number | null = 2): GameState {
    return act(world(), { type: 'LIST_FOR_RENT', playerId: O, tile: 4, laps }).state;
  }

  it('happens when the tenant reaches the office', () => {
    const s = inOffice(listedWorld(2), T);
    assert.deepEqual(legal(s, 'RENT'), [4]);
    const { state, events } = act(s, { type: 'RENT', playerId: T, tile: 4 });
    assert.deepEqual(state.leases[4], { tenant: T, lapsLeft: 2 });
    assert.equal(state.leaseOffers[4], undefined, 'the listing disappears once rented');
    assert.equal(state.owners[4], O, 'the owner stays the owner');
    assert.deepEqual(events, [{ type: 'leased', tenant: T, owner: O, tile: 4, laps: 2 }]);
    assert.equal(state.phase, 'in_office');
    assert.equal(state.players[T].cash, 20000, 'nothing is paid up front');
    assert.deepEqual(checkInvariants(board, state), []);
    assert.deepEqual(legal(state, 'RENT'), []);
  });

  it('keeps an open-ended length', () => {
    const s = act(inOffice(listedWorld(null), T), { type: 'RENT', playerId: T, tile: 4 }).state;
    assert.deepEqual(s.leases[4], { tenant: T, lapsLeft: null });
  });

  it('is not possible outside the office, for your own property, or for an unlisted one', () => {
    const l = listedWorld();
    expectCode(() => act(asCurrent(l, T), { type: 'RENT', playerId: T, tile: 4 }), 'invalid_phase');
    const mine = inOffice(l, O);
    expectCode(() => act(mine, { type: 'RENT', playerId: O, tile: 4 }), 'not_allowed');
    assert.deepEqual(legal(mine, 'RENT'), []);
    const office = inOffice(l, T);
    expectCode(() => act(office, { type: 'RENT', playerId: T, tile: 6 }), 'not_allowed');
    expectCode(() => act(office, { type: 'RENT', playerId: T, tile: 5 }), 'invalid_target');
    expectCode(() => act(office, { type: 'RENT', playerId: V, tile: 4 }), 'wrong_player');
  });

  it('another player cannot rent it once it is taken', () => {
    const taken = act(inOffice(listedWorld(), T), { type: 'RENT', playerId: T, tile: 4 }).state;
    const other = inOffice(taken, V);
    expectCode(() => act(other, { type: 'RENT', playerId: V, tile: 4 }), 'not_allowed');
  });
});

describe('rent at the gate', () => {
  it('the tenant pays 50% to the owner each time he completes a lap, after the gate bonus', () => {
    const s = leased(world(), 4, T, null);
    const { state, events } = completeLap(s, T);
    assert.equal(state.players[T].cash, 20000 + 10000 - 400);
    assert.equal(state.players[O].cash, 20000 + 400);
    assert.deepEqual(
      events.filter((e) => e.type === 'rent_paid'),
      [{ type: 'rent_paid', tenant: T, owner: O, tile: 4, amount: 400, lapsLeft: null }],
    );
    assert.ok(kinds(events).indexOf('gate_bonus') < kinds(events).indexOf('rent_paid'));
    assert.deepEqual(checkInvariants(board, state), []);
  });

  it('is also due when the lap ends by passing the gate, not only by landing on it', () => {
    const s = leased(world(), 4, T, null);
    const ready = patch(forceRoll(asCurrent(s, T), totalIs(4)), (d) => void (d.players[T].position = 35)); // 35+4 -> tile 2
    const { state, events } = act(ready, { type: 'ROLL', playerId: T });
    assert.equal(state.players[T].position, 2);
    assert.equal(events.filter((e) => e.type === 'rent_paid').length, 1);
    assert.equal(state.players[O].cash, 20000 + 400);
  });

  it('is not due when the move does not complete a lap, or for anyone but the tenant', () => {
    const s = leased(world(), 4, T, null);
    const noLap = rollOnto(asCurrent(s, T), 25, 5); // lands on tile 25 without crossing the gate
    assert.equal(kinds(noLap.events).includes('rent_paid'), false);
    const owner = completeLap(s, O);
    assert.equal(kinds(owner.events).includes('rent_paid'), false);
    assert.equal(owner.state.players[O].cash, 30000);
    const visitor = completeLap(s, V);
    assert.equal(kinds(visitor.events).includes('rent_paid'), false);
  });

  it('a fixed lease ends after its last payment and stops charging', () => {
    let s = leased(world(), 4, T, 2);
    const first = completeLap(s, T);
    assert.deepEqual(first.state.leases[4], { tenant: T, lapsLeft: 1 });
    assert.equal(first.events.filter((e) => e.type === 'lease_ended').length, 0);

    const second = completeLap(first.state, T);
    assert.equal(second.state.leases[4], undefined);
    assert.deepEqual(
      second.events.filter((e) => e.type === 'rent_paid' || e.type === 'lease_ended'),
      [
        { type: 'rent_paid', tenant: T, owner: O, tile: 4, amount: 400, lapsLeft: 0 },
        { type: 'lease_ended', tile: 4, owner: O, tenant: T, reason: 'term' },
      ],
    );
    assert.equal(second.state.players[O].cash, 20000 + 800);

    const third = completeLap(second.state, T);
    assert.equal(kinds(third.events).includes('rent_paid'), false);
    assert.equal(third.state.players[O].cash, 20000 + 800);
    s = third.state;
    assert.deepEqual(checkInvariants(board, s), []);
  });

  it('an open-ended lease keeps charging every lap', () => {
    let s = leased(world(), 4, T, null);
    for (let lap = 1; lap <= 4; lap++) s = completeLap(s, T).state;
    assert.equal(s.players[O].cash, 20000 + 4 * 400);
    assert.deepEqual(s.leases[4], { tenant: T, lapsLeft: null });
  });

  it('pays every leased property in tile order', () => {
    const s = leased(leased(world(), 6, T, null), 4, T, null);
    const { state, events } = completeLap(s, T);
    assert.deepEqual(
      events.filter((e) => e.type === 'rent_paid').map((e) => (e as { tile: number }).tile),
      [4, 6],
    );
    assert.equal(state.players[O].cash, 20000 + 400 + 450);
    assert.equal(state.players[T].cash, 30000 - 850);
  });

  it('rent is paid out of cash, after the bank takes its debt from the bonus', () => {
    const s = patch(leased(world(), 4, T, null), (d) => void (d.players[T].bankDebt = 10000));
    const { state } = completeLap(s, T);
    assert.equal(state.players[T].bankDebt, 0);
    assert.equal(state.players[T].cash, 20000 - 400, 'the bonus went to the bank, rent came from cash');
  });

  it('can be paid with exactly the cash on hand', () => {
    const s = patch(withCash(leased(world(), 4, T, null), T, 400), (d) => void (d.players[T].bankDebt = 10000));
    const { state } = completeLap(s, T);
    assert.equal(state.players[T].cash, 0);
    assert.equal(state.phase, 'awaiting_end_turn');
  });

  it('a tenant who cannot pay halts the game before his landing is resolved', () => {
    const s = patch(withCash(leased(world(), 4, T, 3), T, 399), (d) => void (d.players[T].bankDebt = 10000));
    const { state, events } = completeLap(s, T);
    assert.equal(state.phase, 'insolvent');
    assert.deepEqual(state.pending, { type: 'insolvent', cause: 'rent', tile: 4, payer: T, creditor: O, amount: 400 });
    assert.equal(state.players[T].cash, 399);
    assert.equal(state.players[O].cash, 20000);
    assert.deepEqual(state.leases[4], { tenant: T, lapsLeft: 3 }, 'the lap is not counted');
    assert.equal(state.players[T].position, 0, 'the move itself happened');
    assert.equal(kinds(events).includes('landed'), false, 'landing not resolved yet');
    assert.deepEqual(getLegalActions(board, state), []);
    assert.deepEqual(checkInvariants(board, state), []);
  });

  it('rent already paid stays paid when a later lease cannot be', () => {
    // Rent 400 (tile 4) is paid, rent 450 (tile 6) is not: cash 400 after the debt takes the whole bonus.
    const s = patch(withCash(leased(leased(world(), 4, T, null), 6, T, null), T, 400), (d) => void (d.players[T].bankDebt = 10000));
    const { state } = completeLap(s, T);
    assert.equal(state.phase, 'insolvent');
    assert.equal(state.pending?.type === 'insolvent' && state.pending.tile, 6);
    assert.equal(state.players[T].cash, 0);
    assert.equal(state.players[O].cash, 20000 + 400);
  });
});

describe('landing on a leased property', () => {
  const land = (s: GameState, id: number): GameState => rollOnto(asCurrent(s, id), 4, 4).state;

  it('the visitor pays the normal landing fee to the tenant, not to the owner', () => {
    const s = leased(world(), 4, T, null);
    const landed = land(s, V);
    assert.deepEqual(landed.pending, { type: 'fee', tile: 4, payer: V, owner: T, amount: 80 });
    const paid = act(landed, { type: 'COLLECT_FEE', playerId: T }).state;
    assert.equal(paid.players[V].cash, 20000 - 80);
    assert.equal(paid.players[T].cash, 20000 + 80);
    assert.equal(paid.players[O].cash, 20000, 'the owner gets nothing at landing time');
    assert.deepEqual(checkInvariants(board, paid), []);
  });

  it('uses the level and station of the property', () => {
    const s = patch(leased(world(), 4, T, null), (d) => void ((setLevel(d, 4, 3)), (d.stations[4] = O)));
    assert.equal((land(s, V).pending as { amount: number }).amount, 240 + 40);
  });

  it('the tenant, not the owner, decides whether to waive it', () => {
    const landed = land(leased(world(), 4, T, null), V);
    expectCode(() => act(landed, { type: 'WAIVE_FEE', playerId: O }), 'wrong_player');
    expectCode(() => act(landed, { type: 'COLLECT_FEE', playerId: O }), 'wrong_player');
    const waived = act(landed, { type: 'WAIVE_FEE', playerId: T }).state;
    assert.equal(waived.players[V].cash, 20000);
    assert.equal(waived.players[T].cash, 20000);
    assert.deepEqual(
      getLegalActions(board, landed),
      [
        { type: 'COLLECT_FEE', playerId: T },
        { type: 'WAIVE_FEE', playerId: T },
      ],
    );
  });

  it('the owner landing on his own leased property pays nothing', () => {
    const { state, events } = rollOnto(leased(world(), 4, T, null), 4);
    assert.equal(state.phase, 'awaiting_end_turn');
    assert.equal(state.pending, null);
    assert.equal(kinds(events).includes('fee_due'), false);
    assert.equal(state.players[O].cash, 20000);
  });

  it('the tenant landing on the property he rents pays nothing', () => {
    const { state, events } = rollOnto(asCurrent(leased(world(), 4, T, null), T), 4);
    assert.equal(state.phase, 'awaiting_end_turn');
    assert.equal(kinds(events).includes('fee_due'), false);
    assert.equal(state.players[T].cash, 20000);
  });

  it('a property that is only listed still pays the owner', () => {
    const listed = act(world(), { type: 'LIST_FOR_RENT', playerId: O, tile: 4, laps: 2 }).state;
    assert.deepEqual(land(listed, V).pending, { type: 'fee', tile: 4, payer: V, owner: O, amount: 80 });
  });

  it('a visitor who cannot pay halts the game with the tenant as creditor', () => {
    const landed = land(withCash(leased(world(), 4, T, null), V, 79), V);
    const after = act(landed, { type: 'COLLECT_FEE', playerId: T }).state;
    assert.deepEqual(after.pending, { type: 'insolvent', cause: 'fee', tile: 4, payer: V, creditor: T, amount: 80 });
    assert.deepEqual(checkInvariants(board, after), []);
  });
});

describe('ending a lease', () => {
  it('the owner can end any lease during his turn; the fee goes back to him afterwards', () => {
    const fixed = leased(world(), 4, T, 5);
    const { state, events } = act(fixed, { type: 'END_LEASE', playerId: O, tile: 4 });
    assert.equal(state.leases[4], undefined);
    assert.deepEqual(events, [{ type: 'lease_ended', tile: 4, owner: O, tenant: T, reason: 'owner' }]);
    const landed = rollOnto(asCurrent(state, V), 4).state;
    assert.deepEqual(landed.pending, { type: 'fee', tile: 4, payer: V, owner: O, amount: 80 });

    const open = act(leased(world(), 4, T, null), { type: 'END_LEASE', playerId: O, tile: 4 }).state;
    assert.deepEqual(open.leases, {});
  });

  it('no rent is due after it ended', () => {
    const ended = act(leased(world(), 4, T, null), { type: 'END_LEASE', playerId: O, tile: 4 }).state;
    const { events } = completeLap(ended, T);
    assert.equal(kinds(events).includes('rent_paid'), false);
  });

  it('only the owner can end it, and only if it exists', () => {
    const s = leased(world(), 4, T, null);
    expectCode(() => act(asCurrent(s, T), { type: 'END_LEASE', playerId: T, tile: 4 }), 'not_allowed');
    expectCode(() => act(s, { type: 'END_LEASE', playerId: O, tile: 6 }), 'not_allowed');
    expectCode(() => act(s, { type: 'END_LEASE', playerId: O, tile: 5 }), 'invalid_target');
  });
});

describe('restrictions on tenants and leased properties', () => {
  it('the tenant cannot develop, build a station on, mortgage or re-list what he rents', () => {
    const s = inOffice(leased(world(), 4, T, null), T);
    expectCode(() => act(s, { type: 'DEVELOP', playerId: T, tile: 4 }), 'not_allowed');
    expectCode(() => act(s, { type: 'BUILD_STATION', playerId: T, tile: 4 }), 'not_allowed');
    expectCode(() => act(s, { type: 'MORTGAGE', playerId: T, tile: 4 }), 'not_allowed');
    expectCode(() => act(s, { type: 'LIST_FOR_RENT', playerId: T, tile: 4, laps: 2 }), 'not_allowed');
    assert.deepEqual(legal(s, 'DEVELOP'), []);
    assert.deepEqual(legal(s, 'BUILD_STATION'), []);
    assert.deepEqual(legal(s, 'MORTGAGE'), []);
  });

  it('the owner cannot mortgage a leased or listed property until it is freed', () => {
    const s = inOffice(leased(world(), 4, T, null), O);
    expectCode(() => act(s, { type: 'MORTGAGE', playerId: O, tile: 4 }), 'not_allowed');
    assert.ok(!legal(s, 'MORTGAGE').includes(4));
    const freed = act(act(s, { type: 'END_LEASE', playerId: O, tile: 4 }).state, { type: 'MORTGAGE', playerId: O, tile: 4 }).state;
    assert.equal(freed.mortgaged[4], 800);

    const listed = act(inOffice(world(), O), { type: 'LIST_FOR_RENT', playerId: O, tile: 6, laps: 2 }).state;
    expectCode(() => act(listed, { type: 'MORTGAGE', playerId: O, tile: 6 }), 'not_allowed');
    const cancelled = act(listed, { type: 'CANCEL_LISTING', playerId: O, tile: 6 }).state;
    assert.equal(act(cancelled, { type: 'MORTGAGE', playerId: O, tile: 6 }).state.mortgaged[6], 900);
  });

  it('the owner can still develop and build a station on his leased property', () => {
    const s = inOffice(leased(world(), 4, T, null), O);
    assert.ok(legal(s, 'DEVELOP').includes(4));
    const developed = act(s, { type: 'DEVELOP', playerId: O, tile: 4 }).state;
    assert.equal(developed.levels[4], 2);
    assert.equal(act(developed, { type: 'BUILD_STATION', playerId: O, tile: 4 }).state.stations[4], O);
  });
});

describe('purity and saves', () => {
  it('lease actions never mutate their input', () => {
    const s = deepFreeze(world());
    const listed = deepFreeze(act(s, { type: 'LIST_FOR_RENT', playerId: O, tile: 4, laps: 2 }).state);
    const rented = deepFreeze(act(inOffice(listed, T), { type: 'RENT', playerId: T, tile: 4 }).state);
    deepFreeze(completeLap(rented, T));
    act(asCurrent(rented, O), { type: 'END_LEASE', playerId: O, tile: 4 });
    assert.deepEqual(s.leaseOffers, {});
  });

  it('round-trips listings and leases', () => {
    const s = act(leased(world(), 6, T, 3), { type: 'LIST_FOR_RENT', playerId: O, tile: 4, laps: null }).state;
    assert.deepEqual(deserializeGame(board, serializeGame(s)), s);
  });

  it('rejects saves with inconsistent listings and leases', () => {
    const base = leased(world(), 4, T, 2);
    const bad = (change: (d: GameState) => void): string =>
      JSON.stringify({ format: 'nexus-city-save', version: 1, state: patch(base, change) });
    assert.doesNotThrow(() => deserializeGame(board, bad(() => undefined)));
    assert.throws(() => deserializeGame(board, bad((d) => void (d.leases[10] = { tenant: T, lapsLeft: 1 }))), SaveError); // unowned
    assert.throws(() => deserializeGame(board, bad((d) => void (d.leases[4] = { tenant: O, lapsLeft: 1 }))), SaveError); // own tenant
    assert.throws(() => deserializeGame(board, bad((d) => void (d.leases[4] = { tenant: 9, lapsLeft: 1 }))), SaveError);
    assert.throws(() => deserializeGame(board, bad((d) => void (d.leases[4] = { tenant: T, lapsLeft: 0 }))), SaveError);
    assert.throws(() => deserializeGame(board, bad((d) => void (d.leases[4] = { tenant: T, lapsLeft: 1.5 }))), SaveError);
    assert.throws(() => deserializeGame(board, bad((d) => void (d.mortgaged[4] = 800))), SaveError); // mortgaged and leased
    assert.throws(() => deserializeGame(board, bad((d) => void (d.leaseOffers[4] = { laps: 2 }))), SaveError); // listed and leased
    assert.throws(() => deserializeGame(board, bad((d) => void (d.leaseOffers[10] = { laps: 2 }))), SaveError); // unowned
    assert.throws(() => deserializeGame(board, bad((d) => void (d.leaseOffers[6] = { laps: 0 }))), SaveError);
    assert.throws(() => deserializeGame(board, bad((d) => void ((d.mortgaged[6] = 900), (d.leaseOffers[6] = { laps: 2 })))), SaveError);
    assert.throws(
      () => deserializeGame(board, JSON.stringify({ format: 'nexus-city-save', version: 1, state: { ...base, leases: undefined } })),
      SaveError,
    );
  });

  it('rejects a pending fee whose receiver ignores the lease', () => {
    const landed = rollOnto(asCurrent(leased(world(), 4, T, null), V), 4).state;
    assert.doesNotThrow(() => deserializeGame(board, serializeGame(landed)));
    const wrong = patch(landed, (d) => void (d.pending = { type: 'fee', tile: 4, payer: V, owner: O, amount: 80 }));
    assert.throws(() => deserializeGame(board, serializeGame(wrong)), SaveError);
    const ownerPays = patch(landed, (d) => void (d.pending = { type: 'fee', tile: 4, payer: O, owner: T, amount: 80 }));
    assert.throws(() => deserializeGame(board, serializeGame(ownerPays)), SaveError);
  });

  it('rejects a rent insolvency that matches no lease', () => {
    const s = patch(withCash(leased(world(), 4, T, 3), T, 399), (d) => void (d.players[T].bankDebt = 10000));
    const halted = completeLap(s, T).state;
    assert.doesNotThrow(() => deserializeGame(board, serializeGame(halted)));
    const bad = patch(halted, (d) => void delete d.leases[4]);
    assert.throws(() => deserializeGame(board, serializeGame(bad)), SaveError);
  });
});
