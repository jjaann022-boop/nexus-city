import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkInvariants, currentPlayerId, getLegalActions } from '../src/engine/engine.ts';
import { developmentCost, landingFee, ownsFullDistrict, stationCost } from '../src/engine/economy.ts';
import { deserializeGame, SaveError, serializeGame } from '../src/engine/save.ts';
import type { Action, GameState } from '../src/engine/types.ts';
import { act, board, deepFreeze, expectCode, newGame, patch, rollOnto } from './helpers.ts';

// Placeholder board: commercial properties are tiles 1,2,4,6,8 priced 600,700,800,900,1000.
const COMMERCIAL = [1, 2, 4, 6, 8];
const TECH = [10, 11, 13, 15, 17];
const OFFICE = 36;
const price = (tile: number): number => board.tiles[tile].price as number;

/** Player `id` owns the given tiles. */
function owning(state: GameState, id: number, tiles: number[]): GameState {
  return patch(state, (d) => {
    for (const t of tiles) d.owners[t] = id;
  });
}

function withCash(state: GameState, id: number, cash: number): GameState {
  return patch(state, (d) => {
    d.players[id].cash = cash;
  });
}

/** The current player lands on the office. */
function inOffice(state: GameState): GameState {
  const result = rollOnto(state, OFFICE, 4).state;
  assert.equal(result.phase, 'in_office');
  return result;
}

const types = (state: GameState): string[] => getLegalActions(board, state).map((a) => a.type);

describe('economy formulas', () => {
  it('development costs 50% and a station 100% of the original price', () => {
    assert.equal(developmentCost(800), 400);
    assert.equal(stationCost(800), 800);
  });

  it('owning a district means owning all of its properties', () => {
    const me = 0;
    const s = newGame(2);
    assert.equal(ownsFullDistrict(board, s, me, 'commercial'), false);
    assert.equal(ownsFullDistrict(board, owning(s, me, COMMERCIAL.slice(1)), me, 'commercial'), false);
    assert.equal(ownsFullDistrict(board, owning(s, me, COMMERCIAL), me, 'commercial'), true);
    assert.equal(ownsFullDistrict(board, owning(s, me, COMMERCIAL), 1, 'commercial'), false);
    assert.equal(ownsFullDistrict(board, owning(s, me, COMMERCIAL), me, 'tech'), false);
  });

  it('landing fee = property part by level (+ half the station cost when a station stands there)', () => {
    const base = owning(newGame(2), 0, COMMERCIAL);
    const p = price(4); // 800
    const cases: [level: 1 | 2 | 3, station: boolean, fee: number][] = [
      [1, false, 800],
      [2, false, 1200],
      [3, false, 1600],
      [1, true, 1200],
      [2, true, 1600],
      [3, true, 2000],
    ];
    for (const [level, station, fee] of cases) {
      const s = patch(base, (d) => {
        if (level > 1) d.levels[4] = level as 2 | 3;
        if (station) d.stations[4] = 0;
      });
      assert.equal(landingFee(board, s, 4), fee, `level ${level}, station ${station}`);
    }
    assert.equal(p, 800);
  });
});

describe('real estate office', () => {
  it('landing on it opens a session; leaving it returns to the normal end of turn', () => {
    const { state, events } = rollOnto(newGame(), OFFICE, 4);
    const me = currentPlayerId(state);
    assert.equal(state.phase, 'in_office');
    assert.ok(events.some((e) => e.type === 'office_entered'));
    assert.ok(!events.some((e) => e.type === 'tile_not_implemented'));
    assert.deepEqual(getLegalActions(board, state), [{ type: 'LEAVE_OFFICE', playerId: me }]);

    expectCode(() => act(state, { type: 'END_TURN', playerId: me }), 'invalid_phase');
    expectCode(() => act(state, { type: 'ROLL', playerId: me }), 'invalid_phase');

    const left = act(state, { type: 'LEAVE_OFFICE', playerId: me });
    assert.equal(left.state.phase, 'awaiting_end_turn');
    assert.deepEqual(left.events, [{ type: 'office_left', playerId: me }]);
    assert.equal(act(left.state, { type: 'END_TURN', playerId: me }).state.phase, 'awaiting_roll');
  });

  it('only the current player may act inside it', () => {
    const state = inOffice(newGame(3));
    const me = currentPlayerId(state);
    const other = (me + 1) % 3;
    expectCode(() => act(state, { type: 'LEAVE_OFFICE', playerId: other }), 'wrong_player');
    const owner = owning(state, other, COMMERCIAL);
    expectCode(() => act(owner, { type: 'DEVELOP', playerId: other, tile: 1 }), 'wrong_player');
    expectCode(() => act(owner, { type: 'BUILD_STATION', playerId: other, tile: 1 }), 'wrong_player');
  });

  it('development and the office menu are not available anywhere else', () => {
    const s = newGame(2);
    const me = currentPlayerId(s);
    const rich = owning(s, me, COMMERCIAL);
    expectCode(() => act(rich, { type: 'DEVELOP', playerId: me, tile: 1 }), 'invalid_phase'); // awaiting_roll
    const landed = rollOnto(rich, 12, 4).state; // a luck/mystery tile: awaiting_end_turn
    expectCode(() => act(landed, { type: 'DEVELOP', playerId: me, tile: 1 }), 'invalid_phase');
    expectCode(() => act(landed, { type: 'LEAVE_OFFICE', playerId: me }), 'invalid_phase');
  });
});

describe('development', () => {
  function setup(): { state: GameState; me: number } {
    const base = newGame(2);
    const me = currentPlayerId(base);
    return { state: inOffice(owning(base, me, COMMERCIAL)), me };
  }

  it('is offered for every property of a fully owned district', () => {
    const { state, me } = setup();
    const develop = getLegalActions(board, state).filter((a) => a.type === 'DEVELOP');
    assert.deepEqual(
      develop,
      COMMERCIAL.map((tile) => ({ type: 'DEVELOP', playerId: me, tile })),
    );
  });

  it('costs 50% of the original price per step and goes base -> 2 -> 3, one property at a time', () => {
    const { state, me } = setup();
    const first = act(state, { type: 'DEVELOP', playerId: me, tile: 4 });
    assert.equal(first.state.levels[4], 2);
    assert.equal(first.state.players[me].cash, 20000 - 400);
    assert.deepEqual(first.events, [{ type: 'developed', playerId: me, tile: 4, level: 2, cost: 400 }]);
    assert.equal(first.state.levels[1], undefined, 'other properties stay at base level');

    const second = act(first.state, { type: 'DEVELOP', playerId: me, tile: 4 });
    assert.equal(second.state.levels[4], 3);
    assert.equal(second.state.players[me].cash, 20000 - 800);

    expectCode(() => act(second.state, { type: 'DEVELOP', playerId: me, tile: 4 }), 'not_allowed');
    assert.ok(!getLegalActions(board, second.state).some((a) => a.type === 'DEVELOP' && a.tile === 4));
    assert.deepEqual(checkInvariants(board, second.state), []);
  });

  it('can develop several properties during one visit and keeps the session open', () => {
    const { state, me } = setup();
    let s = act(state, { type: 'DEVELOP', playerId: me, tile: 1 }).state;
    s = act(s, { type: 'DEVELOP', playerId: me, tile: 2 }).state;
    s = act(s, { type: 'DEVELOP', playerId: me, tile: 2 }).state;
    assert.equal(s.phase, 'in_office');
    assert.deepEqual({ ...s.levels }, { 1: 2, 2: 3 });
    assert.equal(s.players[me].cash, 20000 - 300 - 350 - 350);
  });

  it('needs every property of the district', () => {
    const base = newGame(2);
    const me = currentPlayerId(base);
    const other = 1 - me;
    // One property of the district belongs to someone else.
    const s = inOffice(patch(owning(base, me, COMMERCIAL), (d) => void (d.owners[8] = other)));
    for (const tile of COMMERCIAL) expectCode(() => act(s, { type: 'DEVELOP', playerId: me, tile }), 'not_allowed');
    assert.ok(!types(s).includes('DEVELOP'), 'development must not be offered');
    // One property of the district is unowned.
    const missing = inOffice(owning(base, me, COMMERCIAL.slice(0, 4)));
    expectCode(() => act(missing, { type: 'DEVELOP', playerId: me, tile: 1 }), 'not_allowed');
  });

  it('owning five properties spread over different districts is not enough', () => {
    const base = newGame(2);
    const me = currentPlayerId(base);
    const s = inOffice(owning(base, me, [1, 2, 4, 10, 11]));
    expectCode(() => act(s, { type: 'DEVELOP', playerId: me, tile: 1 }), 'not_allowed');
    expectCode(() => act(s, { type: 'DEVELOP', playerId: me, tile: 10 }), 'not_allowed');
  });

  it('works in any district the player fully owns', () => {
    const base = newGame(2);
    const me = currentPlayerId(base);
    const s = inOffice(owning(base, me, TECH));
    const after = act(s, { type: 'DEVELOP', playerId: me, tile: 13 }).state;
    assert.equal(after.levels[13], 2);
    assert.equal(after.players[me].cash, 20000 - price(13) / 2);
  });

  it('rejects other targets and unaffordable steps', () => {
    const { state, me } = setup();
    for (const tile of [0, 3, 5, 9, 36, 37, -1, 1.5, Number.NaN]) {
      expectCode(() => act(state, { type: 'DEVELOP', playerId: me, tile }), 'invalid_target');
    }
    expectCode(() => act(state, { type: 'DEVELOP', playerId: me } as unknown as Action), 'invalid_target');
    expectCode(() => act(state, { type: 'DEVELOP', playerId: me, tile: 10 }), 'not_allowed'); // unowned property

    const poor = withCash(state, me, 299);
    expectCode(() => act(poor, { type: 'DEVELOP', playerId: me, tile: 1 }), 'insufficient_cash'); // costs 300
    assert.deepEqual(types(poor), ['LEAVE_OFFICE']);
    const exact = withCash(state, me, 300);
    assert.equal(act(exact, { type: 'DEVELOP', playerId: me, tile: 1 }).state.players[me].cash, 0);
  });
});

describe('stations', () => {
  it('can be built right after landing on your own property, for the original price', () => {
    const base = newGame(2);
    const me = currentPlayerId(base);
    const { state } = rollOnto(owning(base, me, [4]), 4);
    assert.equal(state.phase, 'awaiting_end_turn');
    assert.deepEqual(types(state), ['BUILD_STATION', 'END_TURN']);
    const built = act(state, { type: 'BUILD_STATION', playerId: me, tile: 4 });
    assert.equal(built.state.stations[4], me);
    assert.equal(built.state.players[me].cash, 20000 - 800);
    assert.deepEqual(built.events, [{ type: 'station_built', playerId: me, tile: 4, cost: 800 }]);
    assert.equal(built.state.phase, 'awaiting_end_turn');
    assert.deepEqual(checkInvariants(board, built.state), []);
    assert.deepEqual(types(built.state), ['END_TURN']);
  });

  it('can be built right after buying the property you landed on', () => {
    const base = newGame(2);
    const me = currentPlayerId(base);
    const bought = act(rollOnto(base, 4).state, { type: 'BUY', playerId: me }).state;
    const built = act(bought, { type: 'BUILD_STATION', playerId: me, tile: 4 }).state;
    assert.equal(built.stations[4], me);
    assert.equal(built.players[me].cash, 20000 - 800 - 800);
  });

  it('allows only one station per property', () => {
    const base = newGame(2);
    const me = currentPlayerId(base);
    const built = act(rollOnto(owning(base, me, [4]), 4).state, { type: 'BUILD_STATION', playerId: me, tile: 4 }).state;
    expectCode(() => act(built, { type: 'BUILD_STATION', playerId: me, tile: 4 }), 'not_allowed');
    const office = inOffice(patch(built, (d) => void (d.phase = 'awaiting_roll')));
    expectCode(() => act(office, { type: 'BUILD_STATION', playerId: me, tile: 4 }), 'not_allowed');
  });

  it('outside the office only the tile you stand on qualifies, and only if you own it', () => {
    const base = newGame(2);
    const me = currentPlayerId(base);
    const other = 1 - me;
    const mine = rollOnto(owning(base, me, [4, 6]), 4).state;
    expectCode(() => act(mine, { type: 'BUILD_STATION', playerId: me, tile: 6 }), 'not_allowed');

    // Landing on somebody else's property: after the fee is settled the station is still not allowed.
    const theirs = rollOnto(owning(base, other, [4]), 4).state;
    const settled = act(theirs, { type: 'WAIVE_FEE', playerId: other }).state;
    expectCode(() => act(settled, { type: 'BUILD_STATION', playerId: me, tile: 4 }), 'not_allowed');
    assert.deepEqual(types(settled), ['END_TURN']);

    // Landing on an unowned property: you cannot build before owning it.
    const unowned = rollOnto(base, 4).state;
    assert.equal(unowned.phase, 'awaiting_purchase');
    expectCode(() => act(unowned, { type: 'BUILD_STATION', playerId: me, tile: 4 }), 'invalid_phase');
  });

  it('can be built from the office on any property you own, development not required', () => {
    const base = newGame(2);
    const me = currentPlayerId(base);
    const s = inOffice(owning(base, me, [4, 6, 10]));
    assert.deepEqual(types(s), ['BUILD_STATION', 'BUILD_STATION', 'BUILD_STATION', 'LEAVE_OFFICE']);
    const after = act(s, { type: 'BUILD_STATION', playerId: me, tile: 6 }).state;
    assert.equal(after.stations[6], me);
    assert.equal(after.players[me].cash, 20000 - 900);
    expectCode(() => act(s, { type: 'BUILD_STATION', playerId: me, tile: 5 }), 'invalid_target'); // utility
    expectCode(() => act(s, { type: 'BUILD_STATION', playerId: me, tile: 8 }), 'not_allowed'); // not owned
  });

  it('needs enough cash', () => {
    const base = newGame(2);
    const me = currentPlayerId(base);
    const poor = inOffice(withCash(owning(base, me, [4]), me, 799));
    expectCode(() => act(poor, { type: 'BUILD_STATION', playerId: me, tile: 4 }), 'insufficient_cash');
    assert.deepEqual(types(poor), ['LEAVE_OFFICE']);
    const exact = inOffice(withCash(owning(base, me, [4]), me, 800));
    assert.equal(act(exact, { type: 'BUILD_STATION', playerId: me, tile: 4 }).state.players[me].cash, 0);
  });

  it('can be built on a developed property, and development works on a property with a station', () => {
    const base = newGame(2);
    const me = currentPlayerId(base);
    let s = inOffice(owning(base, me, COMMERCIAL));
    s = act(s, { type: 'DEVELOP', playerId: me, tile: 4 }).state;
    s = act(s, { type: 'BUILD_STATION', playerId: me, tile: 4 }).state;
    s = act(s, { type: 'DEVELOP', playerId: me, tile: 4 }).state;
    assert.equal(s.levels[4], 3);
    assert.equal(s.stations[4], me);
    assert.equal(landingFee(board, s, 4), 1600 + 400);
  });
});

describe('landing fee with development and stations', () => {
  const cases: [string, (d: GameState) => void, number][] = [
    ['base level', () => undefined, 800],
    ['level 2', (d) => void (d.levels[4] = 2), 1200],
    ['level 3', (d) => void (d.levels[4] = 3), 1600],
    ['base level + station', (d) => void (d.stations[4] = 0), 1200],
    ['level 2 + station', (d) => void ((d.levels[4] = 2), (d.stations[4] = 0)), 1600],
    ['level 3 + station', (d) => void ((d.levels[4] = 3), (d.stations[4] = 0)), 2000],
  ];

  for (const [name, change, fee] of cases) {
    it(`${name}: visitor pays ${fee} to the owner`, () => {
      const base = newGame(2);
      const visitor = currentPlayerId(base);
      const owner = 1 - visitor;
      // The owner owns the whole district so levels are consistent; the visitor lands on tile 4.
      const prepared = patch(owning(base, owner, COMMERCIAL), (d) => {
        change(d);
        if (d.stations[4] !== undefined) d.stations[4] = owner;
      });
      const { state, events } = rollOnto(prepared, 4);
      assert.deepEqual(state.pending, { type: 'fee', tile: 4, payer: visitor, owner, amount: fee });
      assert.ok(events.some((e) => e.type === 'fee_due' && e.amount === fee));
      const paid = act(state, { type: 'COLLECT_FEE', playerId: owner }).state;
      assert.equal(paid.players[visitor].cash, 20000 - fee);
      assert.equal(paid.players[owner].cash, 20000 + fee);
      assert.deepEqual(checkInvariants(board, paid), []);
    });
  }

  it('a visitor who cannot pay the full developed fee halts in the insolvent phase', () => {
    const base = newGame(2);
    const visitor = currentPlayerId(base);
    const owner = 1 - visitor;
    const prepared = patch(withCash(owning(base, owner, COMMERCIAL), visitor, 1199), (d) => void (d.levels[4] = 2));
    const { state } = rollOnto(prepared, 4);
    const after = act(state, { type: 'COLLECT_FEE', playerId: owner }).state;
    assert.equal(after.phase, 'insolvent');
    assert.deepEqual(after.pending, { type: 'insolvent', tile: 4, payer: visitor, creditor: owner, amount: 1200 });
    assert.equal(after.players[visitor].cash, 1199);
  });
});

describe('purity and saves', () => {
  it('office actions never mutate their input', () => {
    const base = newGame(2);
    const me = currentPlayerId(base);
    const s = deepFreeze(inOffice(owning(base, me, COMMERCIAL)));
    const developed = deepFreeze(act(s, { type: 'DEVELOP', playerId: me, tile: 1 }).state);
    act(developed, { type: 'BUILD_STATION', playerId: me, tile: 2 });
    act(developed, { type: 'LEAVE_OFFICE', playerId: me });
    assert.equal(s.levels[1], undefined);
  });

  it('round-trips levels, stations and an open office session', () => {
    const base = newGame(3);
    const me = currentPlayerId(base);
    let s = inOffice(owning(base, me, COMMERCIAL));
    s = act(s, { type: 'DEVELOP', playerId: me, tile: 4 }).state;
    s = act(s, { type: 'BUILD_STATION', playerId: me, tile: 6 }).state;
    assert.deepEqual(deserializeGame(board, serializeGame(s)), s);
  });

  it('rejects saves with inconsistent levels, stations or office sessions', () => {
    const base = newGame(2);
    const me = currentPlayerId(base);
    const good = inOffice(owning(base, me, COMMERCIAL));
    const bad = (change: (d: GameState) => void): string => JSON.stringify({ format: 'nexus-city-save', version: 1, state: patch(good, change) });
    assert.doesNotThrow(() => deserializeGame(board, bad(() => undefined)));
    assert.throws(() => deserializeGame(board, bad((d) => void (d.levels[10] = 2))), SaveError); // unowned
    assert.throws(() => deserializeGame(board, bad((d) => void ((d.levels as Record<number, number>)[4] = 5))), SaveError);
    assert.throws(() => deserializeGame(board, bad((d) => void (d.levels[5] = 2))), SaveError); // not a property
    assert.throws(() => deserializeGame(board, bad((d) => void (d.stations[10] = me))), SaveError); // unowned
    assert.throws(() => deserializeGame(board, bad((d) => void (d.stations[4] = 1 - me))), SaveError); // owner mismatch
    assert.throws(() => deserializeGame(board, bad((d) => void (d.players[me].position = 3))), SaveError); // office but not on it
    assert.throws(() => deserializeGame(board, bad((d) => void (d.pending = { type: 'purchase', tile: 4, price: 800 }))), SaveError);
    assert.throws(
      () => deserializeGame(board, JSON.stringify({ format: 'nexus-city-save', version: 1, state: { ...good, levels: undefined } })),
      SaveError,
    );
  });
});
