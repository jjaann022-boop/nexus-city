import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import rawBoard from '../src/data/board.json' with { type: 'json' };
import { parseBoard, validateBoard } from '../src/engine/board.ts';
import { EngineError } from '../src/engine/errors.ts';
import { applyAction, checkInvariants, createGame, currentPlayerId, getLegalActions } from '../src/engine/engine.ts';
import { nextFloat, rollDice, rollDie } from '../src/engine/rng.ts';
import { RULES } from '../src/engine/rules.ts';
import { deserializeGame, SaveError, serializeGame } from '../src/engine/save.ts';
import type { Action, GameEvent, GameState } from '../src/engine/types.ts';
import {
  PLAYERS,
  act,
  board,
  deepFreeze,
  expectCode,
  forceRoll,
  newGame,
  patch,
  playTurn,
  range,
  rollOnto,
  setPosition,
  totalIs,
} from './helpers.ts';

// Tile 4 is a commercial property priced 800 on the placeholder board.
const PROP = 4;
const PROP_PRICE = board.tiles[PROP].price as number;

describe('random numbers', () => {
  it('are deterministic for the same state', () => {
    assert.deepEqual(rollDice(42), rollDice(42));
    assert.deepEqual(nextFloat(7), nextFloat(7));
  });

  it('produce only 1..6, every face appears, and the spread is roughly even', () => {
    let state = 7;
    const counts = new Map<number, number>();
    for (let i = 0; i < 6000; i++) {
      const r = rollDie(state);
      state = r.state;
      assert.ok(Number.isInteger(r.value) && r.value >= 1 && r.value <= 6);
      counts.set(r.value, (counts.get(r.value) ?? 0) + 1);
    }
    assert.equal(counts.size, 6);
    for (const count of counts.values()) assert.ok(count > 800 && count < 1200, `uneven face count ${count}`);
  });
});

describe('board validation', () => {
  type RawBoard = { meta: Record<string, unknown>; tiles: Record<string, unknown>[] };
  const fresh = (): RawBoard => structuredClone(rawBoard) as unknown as RawBoard;

  it('accepts the placeholder board (37 tiles)', () => {
    assert.deepEqual(validateBoard(rawBoard), []);
    assert.equal(board.tiles.length, 37);
    assert.equal(board.meta.temporary, true);
  });

  const broken: [string, (b: RawBoard) => void, RegExp][] = [
    ['too few tiles', (b) => void (b.tiles = b.tiles.slice(0, 12)), /at least 13 tiles/],
    ['gate not first', (b) => void ([b.tiles[0], b.tiles[1]] = [b.tiles[1], b.tiles[0]]), /tile 0 must be the gate/],
    ['two municipalities', (b) => void (b.tiles[36] = { ...b.tiles[9] }), /exactly one municipality/],
    ['missing office', (b) => void (b.tiles[36] = { ...b.tiles[9] }), /exactly one real_estate_office/],
    [
      'district with four properties',
      (b) => void (b.tiles[8] = { name: 'x', kind: 'utility', district: 'commercial' }),
      /commercial needs exactly 5 property/,
    ],
    ['odd price', (b) => void (b.tiles[1].price = 601), /multiple of 10/],
    ['even price that is not a multiple of 10', (b) => void (b.tiles[1].price = 602), /multiple of 10/],
    ['zero price', (b) => void (b.tiles[1].price = 0), /multiple of 10/],
    ['property without price', (b) => void delete b.tiles[1].price, /multiple of 10/],
    ['unknown kind', (b) => void (b.tiles[2].kind = 'castle'), /unknown kind/],
    ['corner inside a district', (b) => void (b.tiles[9].district = 'tech'), /must not belong to a district/],
    ['utility with a price', (b) => void (b.tiles[5].price = 100), /only properties have a price/],
    ['property without district', (b) => void delete b.tiles[1].district, /needs a valid district/],
    ['missing meta', (b) => void delete (b as Partial<RawBoard>).meta, /board\.meta/],
  ];
  for (const [name, mutate, expected] of broken) {
    it(`rejects: ${name}`, () => {
      const b = fresh();
      mutate(b);
      assert.match(validateBoard(b).join('\n'), expected);
    });
  }

  it('parseBoard and createGame refuse an invalid board', () => {
    const b = fresh();
    b.tiles[1].price = 601;
    expectCode(() => parseBoard(b), 'invalid_board');
    expectCode(() => createGame(b as never, PLAYERS.slice(0, 2), 1), 'invalid_board');
    expectCode(() => parseBoard(null), 'invalid_board');
  });
});

describe('game setup', () => {
  it('needs 2 to 6 players with names and colors', () => {
    expectCode(() => createGame(board, PLAYERS.slice(0, 1), 1), 'invalid_setup');
    expectCode(() => createGame(board, [...PLAYERS, { name: 'G', color: 'pink' }], 1), 'invalid_setup');
    expectCode(() => createGame(board, [PLAYERS[0], { name: '  ', color: 'x' }], 1), 'invalid_setup');
    expectCode(() => createGame(board, [PLAYERS[0], { name: 'B', color: '' }], 1), 'invalid_setup');
    expectCode(() => createGame(board, PLAYERS.slice(0, 2), Number.NaN), 'invalid_setup');
    for (let n = 2; n <= 6; n++) assert.equal(createGame(board, PLAYERS.slice(0, n), 1).players.length, n);
  });

  it('starts everyone at the gate with 20,000 and no debt', () => {
    const s = newGame(4, 5);
    assert.equal(RULES.startingCash, 20000);
    for (const p of s.players) {
      assert.equal(p.cash, 20000);
      assert.equal(p.position, 0);
      assert.equal(p.bankDebt, 0);
    }
    assert.equal(s.phase, 'awaiting_roll');
    assert.deepEqual(s.owners, {});
    assert.equal(s.pending, null);
    assert.deepEqual(checkInvariants(board, s), []);
  });

  it('is fully determined by the seed', () => {
    assert.deepEqual(newGame(5, 99), newGame(5, 99));
  });

  it('orders players by their opening throw, highest first, re-throwing only among ties', () => {
    let sawReThrow = false;
    for (let seed = 1; seed <= 300; seed++) {
      const count = 2 + (seed % 5);
      const s = createGame(board, PLAYERS.slice(0, count), seed);
      assert.deepEqual([...s.turnOrder].sort((a, b) => a - b), range(count));

      const first = s.openingRolls.filter((r) => r.round === 1);
      assert.equal(first.length, count, 'everyone throws in round 1');
      const firstTotal = new Map(first.map((r) => [r.playerId, r.total]));
      for (let i = 1; i < s.turnOrder.length; i++) {
        assert.ok((firstTotal.get(s.turnOrder[i - 1]) as number) >= (firstTotal.get(s.turnOrder[i]) as number));
      }

      // Every member of a tie group throws again; players who did not tie do not.
      for (const [id, total] of firstTotal) {
        const tied = [...firstTotal.values()].filter((t) => t === total).length > 1;
        const threwAgain = s.openingRolls.some((r) => r.round === 2 && r.playerId === id);
        assert.equal(threwAgain, tied, `player ${id} re-throw mismatch (seed ${seed})`);
        if (tied) sawReThrow = true;
      }
    }
    assert.ok(sawReThrow, 'expected at least one tie among 300 seeds');
  });
});

describe('movement', () => {
  it('moves by the sum of two dice, clockwise', () => {
    for (const total of [2, 7, 12]) {
      const s = forceRoll(newGame(), totalIs(total));
      const me = currentPlayerId(s);
      const { state, events } = act(s, { type: 'ROLL', playerId: me });
      assert.equal(state.players[me].position, total);
      const rolled = events.find((e) => e.type === 'rolled') as Extract<GameEvent, { type: 'rolled' }>;
      assert.equal(rolled.dice[0] + rolled.dice[1], total);
      assert.deepEqual(state.lastRoll, rolled.dice);
    }
  });

  it('gives no extra turn for doubles', () => {
    let s = forceRoll(newGame(3), (d) => d[0] === 2 && d[1] === 2);
    const first = currentPlayerId(s);
    s = act(s, { type: 'ROLL', playerId: first }).state;
    assert.equal(s.players[first].position, 4);
    assert.notEqual(s.phase, 'awaiting_roll');
    expectCode(() => act(s, { type: 'ROLL', playerId: first }), 'invalid_phase');
    s = act(s, { type: 'DECLINE_PURCHASE', playerId: first }).state;
    s = act(s, { type: 'END_TURN', playerId: first }).state;
    assert.notEqual(currentPlayerId(s), first);
  });

  it('activates only the tile where movement ends', () => {
    // From tile 1, a roll of 11 ends on tile 12 (luck/mystery) after passing properties and the municipality.
    const s0 = newGame();
    const me = currentPlayerId(s0);
    const s = forceRoll(setPosition(s0, me, 1), totalIs(11));
    const { state, events } = act(s, { type: 'ROLL', playerId: me });
    assert.equal(state.players[me].position, 12);
    assert.deepEqual(
      events.filter((e) => e.type === 'landed'),
      [{ type: 'landed', playerId: me, tile: 12 }],
    );
    assert.equal(state.pending, null);
    assert.equal(state.phase, 'awaiting_end_turn');
    assert.equal(state.players[me].cash, 20000);
  });

  it('does nothing yet on tiles whose rules arrive in later phases', () => {
    const { state, events } = rollOnto(newGame(), 9, 6); // municipality
    assert.equal(state.phase, 'awaiting_end_turn');
    assert.ok(events.some((e) => e.type === 'tile_not_implemented' && e.kind === 'municipality'));
  });
});

describe('gate bonus and bank debt', () => {
  it('pays 10,000 when passing the gate', () => {
    const s0 = newGame();
    const me = currentPlayerId(s0);
    const s = forceRoll(setPosition(s0, me, 35), totalIs(4)); // 35 + 4 = 39 -> tile 2
    const { state, events } = act(s, { type: 'ROLL', playerId: me });
    assert.equal(state.players[me].position, 2);
    assert.equal(state.players[me].cash, 30000);
    assert.deepEqual(
      events.find((e) => e.type === 'gate_bonus'),
      { type: 'gate_bonus', playerId: me, bonus: 10000, debtPaid: 0, received: 10000 },
    );
  });

  it('pays 10,000 when arriving exactly on the gate after a lap', () => {
    const s0 = newGame();
    const me = currentPlayerId(s0);
    const s = forceRoll(setPosition(s0, me, 30), totalIs(7)); // 37 -> tile 0
    const { state, events } = act(s, { type: 'ROLL', playerId: me });
    assert.equal(state.players[me].position, 0);
    assert.equal(state.players[me].cash, 30000);
    assert.equal(events.filter((e) => e.type === 'gate_bonus').length, 1);
    assert.equal(state.phase, 'awaiting_end_turn');
  });

  it('pays nothing for starting a turn standing on the gate', () => {
    const s = forceRoll(newGame(), totalIs(5));
    const me = currentPlayerId(s);
    assert.equal(s.players[me].position, 0);
    const { state, events } = act(s, { type: 'ROLL', playerId: me });
    assert.equal(state.players[me].cash, 20000);
    assert.equal(events.filter((e) => e.type === 'gate_bonus').length, 0);
  });

  it('pays nothing when the move does not reach the gate', () => {
    const { state, events } = rollOnto(newGame(), 25, 5);
    assert.equal(events.filter((e) => e.type === 'gate_bonus').length, 0);
    assert.equal(state.players[currentPlayerId(state)].cash, 20000);
  });

  // [debt owed, cash received from the bonus, debt left]
  const cases: [number, number, number][] = [
    [0, 10000, 0],
    [4000, 6000, 0],
    [7000, 3000, 0],
    [10000, 0, 0],
    [12000, 0, 2000],
  ];
  for (const [debt, received, left] of cases) {
    it(`takes bank debt ${debt} out of the bonus first`, () => {
      const s0 = patch(newGame(), (d) => {
        d.players[d.turnOrder[d.turnIndex]].bankDebt = debt;
      });
      const me = currentPlayerId(s0);
      const s = forceRoll(setPosition(s0, me, 35), totalIs(4));
      const { state, events } = act(s, { type: 'ROLL', playerId: me });
      assert.equal(state.players[me].bankDebt, left);
      assert.equal(state.players[me].cash, 20000 + received);
      assert.deepEqual(
        events.find((e) => e.type === 'gate_bonus'),
        { type: 'gate_bonus', playerId: me, bonus: 10000, debtPaid: debt - left, received },
      );
    });
  }
});

describe('buying from the bank', () => {
  it('offers an unowned property and sells it at the original price', () => {
    const { state } = rollOnto(newGame(), PROP);
    const me = currentPlayerId(state);
    assert.equal(state.phase, 'awaiting_purchase');
    assert.deepEqual(state.pending, { type: 'purchase', tile: PROP, price: PROP_PRICE });
    const bought = act(state, { type: 'BUY', playerId: me });
    assert.equal(bought.state.players[me].cash, 20000 - PROP_PRICE);
    assert.equal(bought.state.owners[PROP], me);
    assert.equal(bought.state.phase, 'awaiting_end_turn');
    assert.equal(bought.state.pending, null);
    assert.deepEqual(bought.events, [{ type: 'bought', playerId: me, tile: PROP, price: PROP_PRICE }]);
  });

  it('keeps a declined property available for the next player who lands on it', () => {
    const { state } = rollOnto(newGame(3), PROP);
    const first = currentPlayerId(state);
    let s = act(state, { type: 'DECLINE_PURCHASE', playerId: first }).state;
    assert.equal(s.owners[PROP], undefined);
    s = act(s, { type: 'END_TURN', playerId: first }).state;
    const second = currentPlayerId(s);
    assert.notEqual(second, first);
    const next = rollOnto(s, PROP);
    assert.equal(next.state.phase, 'awaiting_purchase');
    assert.equal(next.state.players[second].cash, 20000);
  });

  it('cannot buy without enough cash, but can still decline', () => {
    const base = newGame();
    const poor = patch(base, (d) => {
      d.players[d.turnOrder[d.turnIndex]].cash = PROP_PRICE - 1;
    });
    const { state } = rollOnto(poor, PROP);
    const me = currentPlayerId(state);
    expectCode(() => act(state, { type: 'BUY', playerId: me }), 'insufficient_cash');
    assert.deepEqual(
      getLegalActions(board, state).map((a) => a.type),
      ['DECLINE_PURCHASE'],
    );
    assert.equal(act(state, { type: 'DECLINE_PURCHASE', playerId: me }).state.phase, 'awaiting_end_turn');
  });

  it('can afford exactly the price (cash may drop to zero)', () => {
    const exact = patch(newGame(), (d) => {
      d.players[d.turnOrder[d.turnIndex]].cash = PROP_PRICE;
    });
    const { state } = rollOnto(exact, PROP);
    const me = currentPlayerId(state);
    const after = act(state, { type: 'BUY', playerId: me }).state;
    assert.equal(after.players[me].cash, 0);
    assert.deepEqual(checkInvariants(board, after), []);
  });

  it('does nothing when landing on your own property', () => {
    const base = newGame();
    const me = currentPlayerId(base);
    const owned = patch(base, (d) => {
      d.owners[PROP] = me;
    });
    const { state, events } = rollOnto(owned, PROP);
    assert.equal(state.phase, 'awaiting_end_turn');
    assert.equal(state.pending, null);
    assert.equal(state.players[me].cash, 20000);
    assert.ok(!events.some((e) => e.type === 'fee_due'));
  });
});

describe('landing fee on another player\'s property', () => {
  function landOnOwned(): { state: GameState; payer: number; owner: number } {
    const base = newGame(3);
    const payer = currentPlayerId(base);
    const owner = (payer + 1) % 3;
    const owned = patch(base, (d) => {
      d.owners[PROP] = owner;
    });
    return { state: rollOnto(owned, PROP).state, payer, owner };
  }

  it('asks the owner; base-level fee is 100% of the original price', () => {
    const { state, payer, owner } = landOnOwned();
    assert.equal(state.phase, 'awaiting_fee_decision');
    assert.deepEqual(state.pending, { type: 'fee', tile: PROP, payer, owner, amount: PROP_PRICE });
    assert.deepEqual(getLegalActions(board, state), [
      { type: 'COLLECT_FEE', playerId: owner },
      { type: 'WAIVE_FEE', playerId: owner },
    ]);
  });

  it('moves the fee from the visitor to the owner when collected', () => {
    const { state, payer, owner } = landOnOwned();
    const { state: after, events } = act(state, { type: 'COLLECT_FEE', playerId: owner });
    assert.equal(after.players[payer].cash, 20000 - PROP_PRICE);
    assert.equal(after.players[owner].cash, 20000 + PROP_PRICE);
    assert.equal(after.phase, 'awaiting_end_turn');
    assert.equal(after.pending, null);
    assert.deepEqual(events, [{ type: 'fee_paid', payer, owner, tile: PROP, amount: PROP_PRICE }]);
  });

  it('moves nothing when the owner waives it', () => {
    const { state, payer, owner } = landOnOwned();
    const { state: after, events } = act(state, { type: 'WAIVE_FEE', playerId: owner });
    assert.equal(after.players[payer].cash, 20000);
    assert.equal(after.players[owner].cash, 20000);
    assert.equal(after.phase, 'awaiting_end_turn');
    assert.deepEqual(events, [{ type: 'fee_waived', payer, owner, tile: PROP, amount: PROP_PRICE }]);
  });

  it('only the owner may decide', () => {
    const { state, payer, owner } = landOnOwned();
    expectCode(() => act(state, { type: 'COLLECT_FEE', playerId: payer }), 'wrong_player');
    expectCode(() => act(state, { type: 'WAIVE_FEE', playerId: payer }), 'wrong_player');
    const bystander = [0, 1, 2].find((id) => id !== payer && id !== owner) as number;
    expectCode(() => act(state, { type: 'COLLECT_FEE', playerId: bystander }), 'wrong_player');
  });

  it('the turn cannot move on until the owner decides', () => {
    const { state, payer } = landOnOwned();
    expectCode(() => act(state, { type: 'END_TURN', playerId: payer }), 'invalid_phase');
    expectCode(() => act(state, { type: 'ROLL', playerId: payer }), 'invalid_phase');
  });

  it('halts in the insolvent phase, moving no money, when the visitor cannot pay', () => {
    const { state, payer, owner } = landOnOwned();
    const broke = patch(state, (d) => {
      d.players[payer].cash = PROP_PRICE - 1;
    });
    const { state: after, events } = act(broke, { type: 'COLLECT_FEE', playerId: owner });
    assert.equal(after.phase, 'insolvent');
    assert.equal(after.players[payer].cash, PROP_PRICE - 1);
    assert.equal(after.players[owner].cash, 20000);
    assert.deepEqual(after.pending, {
      type: 'insolvent',
      cause: 'fee',
      tile: PROP,
      payer,
      creditor: owner,
      amount: PROP_PRICE,
    });
    assert.deepEqual(events, [
      { type: 'insolvent', cause: 'fee', payer, creditor: owner, tile: PROP, amount: PROP_PRICE },
    ]);
    assert.deepEqual(getLegalActions(board, after), []);
    assert.deepEqual(checkInvariants(board, after), []);
    expectCode(() => act(after, { type: 'END_TURN', playerId: payer }), 'invalid_phase');
  });

  it('the owner may still waive when the visitor cannot pay', () => {
    const { state, payer, owner } = landOnOwned();
    const broke = patch(state, (d) => {
      d.players[payer].cash = 0;
    });
    assert.equal(act(broke, { type: 'WAIVE_FEE', playerId: owner }).state.phase, 'awaiting_end_turn');
  });
});

describe('turn flow and authorization', () => {
  it('only the current player may roll, and only when a roll is due', () => {
    const s = newGame(3);
    const me = currentPlayerId(s);
    const other = (me + 1) % 3;
    expectCode(() => act(s, { type: 'ROLL', playerId: other }), 'wrong_player');
    expectCode(() => act(s, { type: 'BUY', playerId: me }), 'invalid_phase');
    expectCode(() => act(s, { type: 'END_TURN', playerId: me }), 'invalid_phase');
    expectCode(() => act(s, { type: 'COLLECT_FEE', playerId: me }), 'invalid_phase');
  });

  it('cannot end the turn while a purchase decision is open', () => {
    const { state } = rollOnto(newGame(), PROP);
    expectCode(() => act(state, { type: 'END_TURN', playerId: currentPlayerId(state) }), 'invalid_phase');
  });

  it('rejects malformed actions', () => {
    const s = newGame();
    expectCode(() => applyAction(board, s, { type: 'FLY', playerId: 0 } as unknown as Action), 'unknown_action');
    expectCode(() => applyAction(board, s, { type: 'ROLL' } as unknown as Action), 'unknown_action');
    expectCode(() => applyAction(board, s, null as unknown as Action), 'unknown_action');
    expectCode(() => applyAction(board, s, { type: 'ROLL', playerId: 1.5 }), 'unknown_action');
  });

  it('rotates through the opening order and wraps around', () => {
    let s = newGame(4, 11);
    const order = [...s.turnOrder];
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      seen.push(currentPlayerId(s));
      s = playTurn(s);
    }
    assert.deepEqual(seen, [...order, ...order]);
  });

  it('ending a turn clears the last roll and starts the next player', () => {
    const s0 = newGame(2);
    const first = currentPlayerId(s0);
    const s1 = playTurn(s0);
    assert.notEqual(currentPlayerId(s1), first);
    assert.equal(s1.phase, 'awaiting_roll');
    assert.equal(s1.lastRoll, null);
  });

  it('exposes exactly the legal actions for each phase', () => {
    const s = newGame(2);
    const me = currentPlayerId(s);
    assert.deepEqual(getLegalActions(board, s), [{ type: 'ROLL', playerId: me }]);
    const { state } = rollOnto(s, PROP);
    assert.deepEqual(
      getLegalActions(board, state).map((a) => a.type),
      ['BUY', 'DECLINE_PURCHASE'],
    );
    for (const action of getLegalActions(board, state)) assert.doesNotThrow(() => act(state, action));
  });
});

describe('purity', () => {
  it('never mutates the state it is given', () => {
    const s = deepFreeze(newGame(3, 8));
    const me = currentPlayerId(s);
    const rolled = deepFreeze(act(s, { type: 'ROLL', playerId: me }).state);
    for (const action of getLegalActions(board, rolled)) act(rolled, action);
    assert.equal(s.phase, 'awaiting_roll');
  });

  it('gives identical results for identical input', () => {
    const s = newGame(3, 8);
    const me = currentPlayerId(s);
    assert.deepEqual(act(s, { type: 'ROLL', playerId: me }), act(s, { type: 'ROLL', playerId: me }));
  });
});

describe('save and load', () => {
  it('round-trips and continues exactly like the original', () => {
    let s = newGame(3, 21);
    for (let i = 0; i < 7; i++) s = playTurn(s);
    const restored = deserializeGame(board, serializeGame(s));
    assert.deepEqual(restored, s);
    let a = s;
    let b = restored;
    for (let i = 0; i < 6; i++) {
      a = playTurn(a);
      b = playTurn(b);
    }
    assert.deepEqual(a, b);
  });

  it('round-trips a game with owned properties and an open decision', () => {
    const base = patch(newGame(3), (d) => {
      d.owners[PROP] = 1;
      d.owners[6] = 2;
      d.players[0].bankDebt = 3000;
    });
    const s = rollOnto(base, 8, 4).state;
    assert.deepEqual(deserializeGame(board, serializeGame(s)), s);
  });

  it('rejects saves that are not valid', () => {
    const good = JSON.parse(serializeGame(newGame())) as { state: GameState } & Record<string, unknown>;
    const bad = (change: (save: typeof good) => void): string => {
      const copy = structuredClone(good);
      change(copy);
      return JSON.stringify(copy);
    };
    assert.throws(() => deserializeGame(board, 'not json'), SaveError);
    assert.throws(() => deserializeGame(board, '42'), SaveError);
    assert.throws(() => deserializeGame(board, '{}'), SaveError);
    assert.throws(() => deserializeGame(board, bad((x) => void (x.version = 2))), SaveError);
    assert.throws(() => deserializeGame(board, bad((x) => void (x.format = 'other'))), SaveError);
    assert.throws(() => deserializeGame(board, bad((x) => void delete (x as Partial<typeof x>).state)), SaveError);
    assert.throws(() => deserializeGame(board, bad((x) => void (x.state.players[0].cash = -5))), SaveError);
    assert.throws(() => deserializeGame(board, bad((x) => void (x.state.players[0].position = 99))), SaveError);
    assert.throws(() => deserializeGame(board, bad((x) => void (x.state.owners[5] = 0))), SaveError); // tile 5 is a utility
    assert.throws(() => deserializeGame(board, bad((x) => void (x.state.owners[PROP] = 9))), SaveError);
    assert.throws(() => deserializeGame(board, bad((x) => void (x.state.turnOrder = [0, 0, 1]))), SaveError);
    assert.throws(() => deserializeGame(board, bad((x) => void (x.state.phase = 'awaiting_purchase'))), SaveError);
    assert.throws(() => deserializeGame(board, bad((x) => void (x.state.players = [] as never))), SaveError);
    assert.throws(() => deserializeGame(board, bad((x) => void (x.state.players = null as never))), SaveError);
    assert.doesNotThrow(() => deserializeGame(board, JSON.stringify(good)));
  });
});

describe('invariant checker', () => {
  it('flags inconsistent states', () => {
    const s = newGame(3);
    assert.deepEqual(checkInvariants(board, s), []);
    const me = currentPlayerId(s);
    assert.ok(checkInvariants(board, patch(s, (d) => void (d.players[0].cash = -1))).length > 0);
    assert.ok(checkInvariants(board, patch(s, (d) => void (d.players[1].bankDebt = 1.5))).length > 0);
    assert.ok(checkInvariants(board, patch(s, (d) => void (d.owners[0] = 0))).length > 0); // the gate is not a property
    assert.ok(checkInvariants(board, patch(s, (d) => void (d.pending = { type: 'purchase', tile: PROP, price: PROP_PRICE }))).length > 0);
    assert.ok(checkInvariants(board, patch(s, (d) => void (d.phase = 'insolvent'))).length > 0);
    const { state } = rollOnto(s, PROP);
    assert.deepEqual(checkInvariants(board, state), []);
    assert.ok(checkInvariants(board, patch(state, (d) => void (d.owners[PROP] = me))).length > 0); // pending sale on an owned tile
    assert.ok(checkInvariants(board, patch(state, (d) => void (d.players[me].position = 6))).length > 0);
  });
});

describe('random play simulation', () => {
  // A simple seeded bot: buys most of the time, collects most fees, sometimes waives.
  function choose(legal: Action[], dice: number): Action {
    const buy = legal.find((a) => a.type === 'BUY');
    if (buy) return dice < 0.8 ? buy : (legal.find((a) => a.type === 'DECLINE_PURCHASE') as Action);
    const collect = legal.find((a) => a.type === 'COLLECT_FEE');
    if (collect) return dice < 0.85 ? collect : (legal.find((a) => a.type === 'WAIVE_FEE') as Action);
    // Prefer moving the game along; otherwise pick any legal action (development, mortgages, leases, ...).
    const roll = legal.find((a) => a.type === 'ROLL');
    if (roll && dice < 0.7) return roll;
    const end = legal.find((a) => a.type === 'END_TURN');
    if (end && dice < 0.5) return end;
    return legal[Math.min(legal.length - 1, Math.floor(dice * legal.length))];
  }

  it('keeps every invariant and conserves money over many random games', () => {
    const totals = { bought: 0, collected: 0, waived: 0, gateBonuses: 0, developed: 0, stations: 0, offices: 0, mortgages: 0, redeems: 0, freeLandings: 0, listings: 0, leases: 0, rents: 0, leaseEnds: 0, turns: 0 };

    for (let seed = 1; seed <= 120; seed++) {
      const count = 2 + (seed % 5);
      let s = createGame(board, PLAYERS.slice(0, count), seed);
      if (seed % 2 === 1) {
        s = patch(s, (d) => {
          d.players[0].bankDebt = 3000;
        });
      }
      if (seed % 3 === 0) {
        // Player 0 starts with the whole commercial district so development actually happens.
        s = patch(s, (d) => {
          for (const tile of [1, 2, 4, 6, 8]) d.owners[tile] = 0;
        });
      }
      const startDebt = s.players.reduce((sum, p) => sum + p.bankDebt, 0);
      let botState = seed * 7919 + 13;
      let received = 0;
      let spent = 0;
      let debtPaid = 0;

      for (let step = 0; step < 2500; step++) {
        const legal = getLegalActions(board, s);
        if (legal.length === 0) break; // insolvency rules arrive in phase 4
        const [f, next] = nextFloat(botState);
        botState = next;
        const result = act(s, choose(legal, f));
        s = result.state;
        for (const e of result.events) {
          if (e.type === 'gate_bonus') {
            received += e.received;
            debtPaid += e.debtPaid;
            totals.gateBonuses++;
          } else if (e.type === 'bought') {
            spent += e.price;
            totals.bought++;
          } else if (e.type === 'mortgaged') {
            received += e.amount;
            totals.mortgages++;
          } else if (e.type === 'redeemed') {
            spent += e.amount;
            totals.redeems++;
          } else if (e.type === 'no_fee_mortgaged') {
            totals.freeLandings++;
          } else if (e.type === 'listed_for_rent') {
            totals.listings++;
          } else if (e.type === 'leased') {
            totals.leases++;
          } else if (e.type === 'rent_paid') {
            totals.rents++; // moves money between players only
          } else if (e.type === 'lease_ended') {
            totals.leaseEnds++;
          } else if (e.type === 'developed') {
            spent += e.cost;
            totals.developed++;
          } else if (e.type === 'station_built') {
            spent += e.cost;
            totals.stations++;
          } else if (e.type === 'office_entered') {
            totals.offices++;
          } else if (e.type === 'fee_paid') {
            totals.collected++;
          } else if (e.type === 'fee_waived') {
            totals.waived++;
          } else if (e.type === 'turn_ended') {
            totals.turns++;
          }
        }
        const problems = checkInvariants(board, s);
        assert.deepEqual(problems, [], `seed ${seed}, step ${step}`);
      }

      // Money only enters through gate bonuses and mortgages, and leaves through purchases,
      // development, stations and redemptions (all with the bank); fees just move it between players.
      const cash = s.players.reduce((sum, p) => sum + p.cash, 0);
      assert.equal(cash, count * RULES.startingCash + received - spent, `money not conserved (seed ${seed})`);
      const debt = s.players.reduce((sum, p) => sum + p.bankDebt, 0);
      assert.equal(debt, startDebt - debtPaid, `bank debt not conserved (seed ${seed})`);
    }

    assert.ok(totals.bought > 100, 'bots should buy properties');
    assert.ok(totals.collected > 20, 'bots should collect fees');
    assert.ok(totals.waived > 0, 'bots should sometimes waive');
    assert.ok(totals.gateBonuses > 20, 'bots should lap the board');
    assert.ok(totals.turns > 1000);
    assert.ok(totals.offices > 20, 'bots should visit the office');
    assert.ok(totals.developed > 5, 'bots should develop properties');
    assert.ok(totals.stations > 5, 'bots should build stations');
    assert.ok(totals.mortgages > 5, 'bots should mortgage');
    assert.ok(totals.redeems > 0, 'bots should redeem');
    assert.ok(totals.freeLandings > 0, 'someone should land on a mortgaged property');
    assert.ok(totals.listings > 5, 'bots should offer properties for rent');
    assert.ok(totals.leases > 2, 'bots should rent properties');
    assert.ok(totals.rents > 0, 'tenants should pay rent');
    assert.ok(totals.leaseEnds > 0, 'leases should end');
  });
});

// Keep the EngineError export exercised so a rename in errors.ts is caught here.
describe('errors', () => {
  it('carry a code', () => {
    const e = new EngineError('wrong_player', 'x');
    assert.equal(e.code, 'wrong_player');
    assert.ok(e instanceof Error);
  });
});
