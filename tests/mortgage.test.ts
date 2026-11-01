import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkInvariants, currentPlayerId, getLegalActions } from '../src/engine/engine.ts';
import { mortgageValue, ownsFullDistrict } from '../src/engine/economy.ts';
import { deserializeGame, SaveError, serializeGame } from '../src/engine/save.ts';
import type { Action, GameState } from '../src/engine/types.ts';
import { act, board, deepFreeze, expectCode, newGame, patch, rollOnto } from './helpers.ts';

// Placeholder board: commercial properties are tiles 1,2,4,6,8 priced 600,700,800,900,1000.
const COMMERCIAL = [1, 2, 4, 6, 8];
const OFFICE = 36;

function owning(state: GameState, id: number, tiles: number[]): GameState {
  return patch(state, (d) => {
    for (const t of tiles) d.owners[t] = id;
  });
}

function inOffice(state: GameState): GameState {
  const result = rollOnto(state, OFFICE, 4).state;
  assert.equal(result.phase, 'in_office');
  return result;
}

const withCash = (state: GameState, id: number, cash: number): GameState =>
  patch(state, (d) => void (d.players[id].cash = cash));

const legalTypes = (state: GameState, type: Action['type']): number[] =>
  getLegalActions(board, state)
    .filter((a) => a.type === type)
    .map((a) => (a as { tile: number }).tile);

/** The current player, who owns the whole commercial district, is in the office. */
function setup(): { state: GameState; me: number; other: number } {
  const base = newGame(2);
  const me = currentPlayerId(base);
  return { state: inOffice(owning(base, me, COMMERCIAL)), me, other: 1 - me };
}

describe('mortgage value', () => {
  const base = owning(newGame(2), 0, COMMERCIAL);

  it('is the original price for a plain property', () => {
    assert.equal(mortgageValue(board, base, 4), 800);
  });

  it('adds what was paid for development (price 800, level 3 -> 800 + 800 = 1600)', () => {
    assert.equal(mortgageValue(board, patch(base, (d) => void (d.levels[4] = 3)), 4), 1600);
    assert.equal(mortgageValue(board, patch(base, (d) => void (d.levels[4] = 2)), 4), 1200);
  });

  it('adds the station price (its build cost = the original price)', () => {
    assert.equal(mortgageValue(board, patch(base, (d) => void (d.stations[4] = 0)), 4), 1600);
    assert.equal(
      mortgageValue(board, patch(base, (d) => void ((d.levels[4] = 2), (d.stations[4] = 0))), 4),
      800 + 400 + 800,
    );
  });
});

describe('mortgaging', () => {
  it('gives the owner the value from the bank, and keeps level and station', () => {
    const { state, me } = setup();
    let s = act(state, { type: 'DEVELOP', playerId: me, tile: 4 }).state;
    s = act(s, { type: 'DEVELOP', playerId: me, tile: 4 }).state; // level 3, paid 800
    s = act(s, { type: 'BUILD_STATION', playerId: me, tile: 4 }).state; // paid 800
    const before = s.players[me].cash;
    const { state: after, events } = act(s, { type: 'MORTGAGE', playerId: me, tile: 4 });
    assert.equal(after.mortgaged[4], 2400); // 800 + 800 + 800
    assert.equal(after.players[me].cash, before + 2400);
    assert.deepEqual(events, [{ type: 'mortgaged', playerId: me, tile: 4, amount: 2400 }]);
    assert.equal(after.levels[4], 3);
    assert.equal(after.stations[4], me);
    assert.equal(after.owners[4], me);
    assert.equal(after.phase, 'in_office');
    assert.deepEqual(checkInvariants(board, after), []);
  });

  it('is offered for every owned, unmortgaged property and nothing else', () => {
    const { state, me } = setup();
    assert.deepEqual(legalTypes(state, 'MORTGAGE'), COMMERCIAL);
    const once = act(state, { type: 'MORTGAGE', playerId: me, tile: 2 }).state;
    assert.deepEqual(legalTypes(once, 'MORTGAGE'), [1, 4, 6, 8]);
    assert.deepEqual(legalTypes(once, 'REDEEM'), [2]);
  });

  it('is refused for other targets, twice, for non-owners, and outside the office', () => {
    const { state, me, other } = setup();
    for (const tile of [0, 3, 5, 9, 36, 99, -1, 2.5, Number.NaN]) {
      expectCode(() => act(state, { type: 'MORTGAGE', playerId: me, tile }), 'invalid_target');
    }
    expectCode(() => act(state, { type: 'MORTGAGE', playerId: me, tile: 10 }), 'not_allowed'); // unowned
    const theirs = inOffice(owning(newGame(2), other, [4]));
    expectCode(() => act(theirs, { type: 'MORTGAGE', playerId: currentPlayerId(theirs), tile: 4 }), 'not_allowed');

    const once = act(state, { type: 'MORTGAGE', playerId: me, tile: 4 }).state;
    expectCode(() => act(once, { type: 'MORTGAGE', playerId: me, tile: 4 }), 'not_allowed');

    const base = owning(newGame(2), me, [4]);
    expectCode(() => act(base, { type: 'MORTGAGE', playerId: me, tile: 4 }), 'invalid_phase'); // awaiting_roll
    const landed = rollOnto(base, 4).state; // own property -> awaiting_end_turn
    expectCode(() => act(landed, { type: 'MORTGAGE', playerId: me, tile: 4 }), 'invalid_phase');
    expectCode(() => act(landed, { type: 'REDEEM', playerId: me, tile: 4 }), 'invalid_phase');
  });

  it('only the current player may mortgage', () => {
    const { state, other } = setup();
    expectCode(() => act(state, { type: 'MORTGAGE', playerId: other, tile: 4 }), 'wrong_player');
    expectCode(() => act(state, { type: 'REDEEM', playerId: other, tile: 4 }), 'wrong_player');
  });
});

describe('redeeming', () => {
  it('costs exactly the amount received, with no interest', () => {
    const { state, me } = setup();
    let s = act(state, { type: 'DEVELOP', playerId: me, tile: 4 }).state; // level 2, paid 400
    const cash = s.players[me].cash;
    s = act(s, { type: 'MORTGAGE', playerId: me, tile: 4 }).state; // +1200
    assert.equal(s.players[me].cash, cash + 1200);
    const { state: after, events } = act(s, { type: 'REDEEM', playerId: me, tile: 4 });
    assert.equal(after.players[me].cash, cash);
    assert.equal(after.mortgaged[4], undefined);
    assert.deepEqual(events, [{ type: 'redeemed', playerId: me, tile: 4, amount: 1200 }]);
    assert.equal(after.levels[4], 2);
    assert.deepEqual(checkInvariants(board, after), []);
  });

  it('needs the full amount in cash', () => {
    const { state, me } = setup();
    const s = act(state, { type: 'MORTGAGE', playerId: me, tile: 4 }).state; // amount 800
    const poor = withCash(s, me, 799);
    expectCode(() => act(poor, { type: 'REDEEM', playerId: me, tile: 4 }), 'insufficient_cash');
    assert.deepEqual(legalTypes(poor, 'REDEEM'), []);
    const exact = withCash(s, me, 800);
    assert.equal(act(exact, { type: 'REDEEM', playerId: me, tile: 4 }).state.players[me].cash, 0);
  });

  it('is refused for a property that is not mortgaged or not yours', () => {
    const { state, me } = setup();
    expectCode(() => act(state, { type: 'REDEEM', playerId: me, tile: 4 }), 'not_allowed');
    expectCode(() => act(state, { type: 'REDEEM', playerId: me, tile: 10 }), 'not_allowed');
    expectCode(() => act(state, { type: 'REDEEM', playerId: me, tile: 3 }), 'invalid_target');
  });
});

describe('what a mortgage changes', () => {
  it('a mortgaged property charges no landing fee', () => {
    const base = newGame(2);
    const visitor = currentPlayerId(base);
    const owner = 1 - visitor;
    const prepared = patch(owning(base, owner, [4]), (d) => void (d.mortgaged[4] = 800));
    const { state, events } = rollOnto(prepared, 4);
    assert.equal(state.phase, 'awaiting_end_turn');
    assert.equal(state.pending, null);
    assert.equal(state.players[visitor].cash, 20000);
    assert.equal(state.players[owner].cash, 20000);
    assert.deepEqual(
      events.filter((e) => e.type === 'no_fee_mortgaged'),
      [{ type: 'no_fee_mortgaged', payer: visitor, owner, tile: 4 }],
    );
    assert.ok(!events.some((e) => e.type === 'fee_due'));
    assert.deepEqual(checkInvariants(board, state), []);
  });

  it('the fee comes back once the owner redeems it', () => {
    const base = newGame(2);
    const visitor = currentPlayerId(base);
    const owner = 1 - visitor;
    const prepared = patch(owning(base, owner, [4]), (d) => void (d.mortgaged[4] = 800));
    // Redeem as the owner would in the office, then the visitor lands.
    const redeemed = patch(prepared, (d) => void delete d.mortgaged[4]);
    assert.equal(rollOnto(redeemed, 4).state.phase, 'awaiting_fee_decision');
  });

  it('landing on your own mortgaged property does nothing and offers no station', () => {
    const base = newGame(2);
    const me = currentPlayerId(base);
    const prepared = patch(owning(base, me, [4]), (d) => void (d.mortgaged[4] = 800));
    const { state } = rollOnto(prepared, 4);
    assert.equal(state.phase, 'awaiting_end_turn');
    assert.deepEqual(
      getLegalActions(board, state).map((a) => a.type),
      ['END_TURN'],
      'no station on a mortgaged property',
    );
  });

  it('a mortgaged property does not count toward owning the district: nothing in it can be developed', () => {
    const { state, me } = setup();
    assert.equal(ownsFullDistrict(board, state, me, 'commercial'), true);
    const s = act(state, { type: 'MORTGAGE', playerId: me, tile: 8 }).state;
    assert.equal(ownsFullDistrict(board, s, me, 'commercial'), false);
    for (const tile of COMMERCIAL) expectCode(() => act(s, { type: 'DEVELOP', playerId: me, tile }), 'not_allowed');
    assert.deepEqual(legalTypes(s, 'DEVELOP'), []);

    const back = act(s, { type: 'REDEEM', playerId: me, tile: 8 }).state;
    assert.equal(ownsFullDistrict(board, back, me, 'commercial'), true);
    assert.deepEqual(legalTypes(back, 'DEVELOP'), COMMERCIAL);
  });

  it('levels already built elsewhere in the district stay and still charge their fee', () => {
    const { state, me, other } = setup();
    let s = act(state, { type: 'DEVELOP', playerId: me, tile: 4 }).state; // level 2: fee 160
    s = act(s, { type: 'MORTGAGE', playerId: me, tile: 8 }).state;
    assert.equal(s.levels[4], 2);
    // The visitor (the other player) lands on tile 4.
    const turn = patch(s, (d) => {
      d.phase = 'awaiting_roll';
      d.turnIndex = d.turnOrder.indexOf(other);
      d.players[me].position = OFFICE;
    });
    const { state: landed } = rollOnto(turn, 4);
    assert.deepEqual(landed.pending, { type: 'fee', tile: 4, payer: other, owner: me, amount: 160 });
  });

  it('a mortgaged property cannot be developed or get a station, even from the office', () => {
    const { state, me } = setup();
    const s = act(state, { type: 'MORTGAGE', playerId: me, tile: 4 }).state;
    expectCode(() => act(s, { type: 'DEVELOP', playerId: me, tile: 4 }), 'not_allowed');
    expectCode(() => act(s, { type: 'BUILD_STATION', playerId: me, tile: 4 }), 'not_allowed');
    assert.ok(!legalTypes(s, 'BUILD_STATION').includes(4));
    assert.ok(legalTypes(s, 'BUILD_STATION').includes(6), 'other properties are unaffected');
  });
});

describe('purity and saves', () => {
  it('mortgage actions never mutate their input', () => {
    const { state, me } = setup();
    const frozen = deepFreeze(state);
    const mortgaged = deepFreeze(act(frozen, { type: 'MORTGAGE', playerId: me, tile: 4 }).state);
    act(mortgaged, { type: 'REDEEM', playerId: me, tile: 4 });
    assert.equal(frozen.mortgaged[4], undefined);
  });

  it('round-trips a game with mortgages', () => {
    const { state, me } = setup();
    let s = act(state, { type: 'DEVELOP', playerId: me, tile: 4 }).state;
    s = act(s, { type: 'MORTGAGE', playerId: me, tile: 4 }).state;
    s = act(s, { type: 'MORTGAGE', playerId: me, tile: 1 }).state;
    assert.deepEqual(deserializeGame(board, serializeGame(s)), s);
  });

  it('rejects saves with inconsistent mortgages', () => {
    const { state } = setup();
    const bad = (change: (d: GameState) => void): string =>
      JSON.stringify({ format: 'nexus-city-save', version: 1, state: patch(state, change) });
    assert.doesNotThrow(() => deserializeGame(board, bad((d) => void (d.mortgaged[4] = 800))));
    assert.throws(() => deserializeGame(board, bad((d) => void (d.mortgaged[10] = 800))), SaveError); // unowned
    assert.throws(() => deserializeGame(board, bad((d) => void (d.mortgaged[5] = 800))), SaveError); // not a property
    assert.throws(() => deserializeGame(board, bad((d) => void (d.mortgaged[4] = 0))), SaveError);
    assert.throws(() => deserializeGame(board, bad((d) => void (d.mortgaged[4] = -800))), SaveError);
    assert.throws(() => deserializeGame(board, bad((d) => void (d.mortgaged[4] = 800.5))), SaveError);
    assert.throws(
      () => deserializeGame(board, JSON.stringify({ format: 'nexus-city-save', version: 1, state: { ...state, mortgaged: undefined } })),
      SaveError,
    );
  });
});
