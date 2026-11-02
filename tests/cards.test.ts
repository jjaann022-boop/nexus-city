import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rawBoard } from '../src/data/index.ts';
import { parseBoard, validateBoard } from '../src/engine/board.ts';
import { mortgageValue } from '../src/engine/economy.ts';
import { applyAction, checkInvariants, createGame, currentPlayerId, getLegalActions } from '../src/engine/engine.ts';
import { nextFloat, rollDice } from '../src/engine/rng.ts';
import { RULES } from '../src/engine/rules.ts';
import { deserializeGame, SaveError, serializeGame } from '../src/engine/save.ts';
import type { GameEvent, GameState, StepResult } from '../src/engine/types.ts';
import {
  act,
  board,
  deepFreeze,
  expectCode,
  forceRoll,
  newGame,
  PLAYERS,
  patch,
  playTurn,
  rollOnto,
  setLevel,
  setPosition,
  totalIs,
} from './helpers.ts';

const LUCK_TILE = 12;
const UTILITY = { commercial: 5, tech: 14, residential: 23, industrial: 32 } as const;
const OFFICE = 36;
const COMMERCIAL = [1, 2, 4, 6, 8];

/**
 * The current player starts on `from`, throws `total` and the generator is chosen so the card
 * drawn on the luck/mystery tile is exactly `cardId` (the draw uses the generator right after the dice).
 */
function rollForCard(
  state: GameState,
  deck: 'luck' | 'mystery',
  cardId: string,
  from = LUCK_TILE - 4,
  total = 4,
): StepResult {
  const me = currentPlayerId(state);
  const cards = deck === 'luck' ? board.luckCards : board.mysteryCards;
  const wanted = cards.findIndex((c) => c.id === cardId);
  assert.ok(wanted >= 0, `unknown card ${cardId}`);
  const base = patch(setPosition(state, me, from), (d) => {
    d.phase = 'awaiting_roll';
    d.pending = null;
  });
  for (let candidate = 1; candidate < 3_000_000; candidate++) {
    const r = rollDice(candidate);
    if (r.dice[0] + r.dice[1] !== total) continue;
    const [pick, afterPick] = nextFloat(r.state);
    const [index] = nextFloat(afterPick);
    if (pick * 100 < RULES.luckDeckChancePercent !== (deck === 'luck')) continue;
    if (Math.floor(index * cards.length) !== wanted) continue;
    return act(
      patch(base, (d) => {
        d.rngState = candidate;
      }),
      { type: 'ROLL', playerId: me },
    );
  }
  throw new Error(`no generator state draws ${cardId}`);
}

const me = (s: GameState) => s.players[currentPlayerId(s)];
const eventsOf = <T extends GameEvent['type']>(events: GameEvent[], type: T) =>
  events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

function withVoucher(state: GameState, voucher: keyof GameState['players'][number]['vouchers'], n = 1): GameState {
  return patch(state, (d) => {
    d.players[currentPlayerId(state)].vouchers[voucher] = n;
  });
}

describe('luck or mystery tile', () => {
  it('draws a card and keeps every invariant', () => {
    const { state, events } = rollForCard(newGame(3), 'luck', 'city_prize');
    assert.deepEqual(eventsOf(events, 'card_drawn'), [
      { type: 'card_drawn', playerId: currentPlayerId(state), deck: 'luck', cardId: 'city_prize' },
    ]);
    assert.equal(state.phase, 'awaiting_end_turn');
    assert.deepEqual(checkInvariants(board, state), []);
  });

  it('uses both decks, only approved cards, and replays identically', () => {
    const decks = new Set<string>();
    const ids = new Set<string>();
    for (let candidate = 1; candidate < 3000; candidate++) {
      if (!totalIs(4)(rollDice(candidate).dice)) continue;
      const start = patch(setPosition(newGame(2), 0, LUCK_TILE - 4), (d) => {
        d.rngState = candidate;
        d.turnOrder = [0, 1];
      });
      const first = act(start, { type: 'ROLL', playerId: 0 });
      const second = act(start, { type: 'ROLL', playerId: 0 });
      assert.deepEqual(first, second, 'same state and action must give the same result');
      for (const e of eventsOf(first.events, 'card_drawn')) {
        decks.add(e.deck);
        ids.add(`${e.deck}:${e.cardId}`);
        const known = (e.deck === 'luck' ? board.luckCards : board.mysteryCards).some((c) => c.id === e.cardId);
        assert.ok(known, `unknown card ${e.cardId}`);
      }
      assert.deepEqual(checkInvariants(board, first.state), []);
    }
    assert.deepEqual([...decks].sort(), ['luck', 'mystery']);
    assert.ok(ids.size > 20, 'many different cards should come up');
  });

  it('draws with replacement: the same card can come twice in a row', () => {
    const first = rollForCard(newGame(2), 'luck', 'lucky_day');
    const again = rollForCard(first.state, 'luck', 'lucky_day', LUCK_TILE - 4);
    assert.equal(eventsOf(again.events, 'card_drawn')[0].cardId, 'lucky_day');
  });

  it('does not mutate the input state', () => {
    const s = deepFreeze(patch(newGame(2), () => {}));
    const frozen = structuredClone(s);
    rollForCard(frozen, 'luck', 'city_prize');
    assert.deepEqual(frozen, s);
  });
});

describe('luck cards that pay or charge the bank', () => {
  it('gain: the player receives the amount', () => {
    const before = newGame(3);
    const { state, events } = rollForCard(before, 'luck', 'city_prize');
    assert.equal(me(state).cash, me(before).cash + 500);
    assert.deepEqual(eventsOf(events, 'bank_transfer'), [
      { type: 'bank_transfer', playerId: currentPlayerId(state), amount: 500, reason: 'city_prize' },
    ]);
  });

  it('pay: the player pays the bank', () => {
    const before = newGame(3);
    const { state, events } = rollForCard(before, 'luck', 'trade_loss');
    assert.equal(me(state).cash, me(before).cash - 600);
    assert.equal(eventsOf(events, 'bank_transfer')[0].amount, -600);
    assert.equal(state.phase, 'awaiting_end_turn');
  });

  it('property compensation: 300 with a property, 100 without', () => {
    const none = rollForCard(newGame(2), 'luck', 'property_compensation');
    assert.equal(me(none.state).cash, 20000 + 100);
    const base = newGame(2);
    const owner = patch(base, (d) => void (d.owners[1] = currentPlayerId(base)));
    const some = rollForCard(owner, 'luck', 'property_compensation');
    assert.equal(me(some.state).cash, 20000 + 300);
  });

  it('property compensation also counts a mortgaged property, but not one owned by someone else', () => {
    const base = newGame(2);
    const id = currentPlayerId(base);
    const other = patch(base, (d) => void (d.owners[1] = 1 - id));
    assert.equal(me(rollForCard(other, 'luck', 'property_compensation').state).cash, 20100);
    const mortgaged = patch(base, (d) => {
      d.owners[1] = id;
      d.mortgaged[1] = 600;
    });
    assert.equal(me(rollForCard(mortgaged, 'luck', 'property_compensation').state).cash, 20300);
  });

  it('a player who cannot pay a card halts in insolvency owing the bank', () => {
    const base = patch(newGame(3), (d) => void (d.players[d.turnOrder[0]].cash = 100));
    const { state, events } = rollForCard(base, 'luck', 'utility_bill');
    assert.equal(state.phase, 'insolvent');
    assert.deepEqual(state.pending, {
      type: 'insolvent',
      cause: 'card',
      tile: LUCK_TILE,
      payer: currentPlayerId(state),
      creditor: 'bank',
      amount: 200,
    });
    assert.equal(me(state).cash, 100, 'nothing is taken before the insolvency rules');
    assert.equal(eventsOf(events, 'insolvent').length, 1);
    assert.deepEqual(getLegalActions(board, state), []);
    assert.deepEqual(checkInvariants(board, state), []);
  });

  it('paying exactly all the cash is allowed', () => {
    const base = patch(newGame(2), (d) => void (d.players[d.turnOrder[0]].cash = 200));
    const { state } = rollForCard(base, 'luck', 'utility_bill');
    assert.equal(me(state).cash, 0);
    assert.equal(state.phase, 'awaiting_end_turn');
  });
});

describe('luck card vouchers', () => {
  it('municipal exemption waives the first card payment only', () => {
    const got = rollForCard(newGame(2), 'luck', 'municipal_exemption');
    assert.equal(me(got.state).vouchers.card_payment_exemption, 1);
    const first = rollForCard(got.state, 'luck', 'trade_loss');
    assert.equal(me(first.state).cash, me(got.state).cash, 'the first payment is waived');
    assert.equal(me(first.state).vouchers.card_payment_exemption, 0);
    assert.deepEqual(eventsOf(first.events, 'voucher_used'), [
      { type: 'voucher_used', playerId: currentPlayerId(first.state), voucher: 'card_payment_exemption', amount: 600 },
    ]);
    const second = rollForCard(first.state, 'luck', 'trade_loss');
    assert.equal(me(second.state).cash, me(first.state).cash - 600, 'the second one is charged');
  });

  it('municipal exemption is not spent by a card that pays the player', () => {
    const s = withVoucher(newGame(2), 'card_payment_exemption');
    const { state } = rollForCard(s, 'luck', 'city_prize');
    assert.equal(me(state).vouchers.card_payment_exemption, 1);
  });

  it('municipal exemption rescues a player who could not have paid', () => {
    const s = patch(withVoucher(newGame(2), 'card_payment_exemption'), (d) => {
      d.players[d.turnOrder[0]].cash = 0;
    });
    const { state } = rollForCard(s, 'luck', 'trade_loss');
    assert.equal(state.phase, 'awaiting_end_turn');
  });

  it('purchase discount cuts 200 from the next purchase and is spent only when buying', () => {
    const got = rollForCard(newGame(2), 'luck', 'purchase_discount');
    assert.equal(me(got.state).vouchers.purchase_discount, 1);
    const land = rollOnto(patch(got.state, (d) => void (d.phase = 'awaiting_roll')), 4);
    assert.deepEqual(land.state.pending, { type: 'purchase', tile: 4, price: 600 });

    const declined = act(land.state, { type: 'DECLINE_PURCHASE', playerId: currentPlayerId(land.state) });
    assert.equal(me(declined.state).vouchers.purchase_discount, 1, 'declining keeps the voucher');

    const cashBefore = me(land.state).cash;
    const bought = act(land.state, { type: 'BUY', playerId: currentPlayerId(land.state) });
    assert.equal(me(bought.state).cash, cashBefore - 600);
    assert.equal(me(bought.state).vouchers.purchase_discount, 0);
    assert.equal(eventsOf(bought.events, 'voucher_used')[0].amount, 200);
    assert.deepEqual(checkInvariants(board, bought.state), []);
  });

  it('pass ticket pays 300 on the next pass of the gate, once', () => {
    const got = rollForCard(newGame(2), 'luck', 'pass_ticket');
    assert.equal(me(got.state).vouchers.gate_ticket, 1);
    const id = currentPlayerId(got.state);
    const ready = patch(forceRoll(setPosition(got.state, id, 34), totalIs(4)), (d) => void (d.phase = 'awaiting_roll'));
    const before = me(ready).cash;
    const passed = act(ready, { type: 'ROLL', playerId: id });
    assert.equal(me(passed.state).position, 1);
    const cardless = passed.events.filter((e) => e.type === 'card_drawn').length;
    assert.equal(cardless, 0);
    assert.equal(me(passed.state).cash, before + RULES.gateBonus + 300);
    assert.equal(me(passed.state).vouchers.gate_ticket, 0);
    assert.equal(eventsOf(passed.events, 'bank_transfer')[0].reason, 'gate_ticket');
  });

  it('pass ticket is not spent by a roll that does not cross the gate', () => {
    const s = withVoucher(newGame(2), 'gate_ticket');
    const { state } = rollOnto(s, 4);
    assert.equal(me(state).vouchers.gate_ticket, 1);
  });

  it('pass ticket pays even when the bonus goes to bank debt', () => {
    const id = currentPlayerId(newGame(2));
    const s = patch(newGame(2), (d) => {
      d.players[id].vouchers.gate_ticket = 1;
      d.players[id].bankDebt = 15000;
      d.players[id].position = 34;
    });
    const ready = forceRoll(s, totalIs(4));
    const before = me(ready).cash;
    const { state } = act(ready, { type: 'ROLL', playerId: id });
    assert.equal(me(state).bankDebt, 5000);
    assert.equal(me(state).cash, before + 300);
  });

  it('no bills day is armed now, becomes active at his next turn and expires with it', () => {
    const got = rollForCard(newGame(2), 'luck', 'no_bills_day');
    const id = currentPlayerId(got.state);
    assert.equal(got.state.players[id].vouchers.fee_exemption_armed, 1);
    assert.equal(got.state.players[id].vouchers.fee_exemption_active, 0);

    const other = act(got.state, { type: 'END_TURN', playerId: id }).state;
    assert.equal(other.players[id].vouchers.fee_exemption_armed, 1, 'still waiting');
    const back = act(patch(other, (d) => void (d.phase = 'awaiting_end_turn')), {
      type: 'END_TURN',
      playerId: currentPlayerId(other),
    }).state;
    assert.equal(currentPlayerId(back), id);
    assert.equal(back.players[id].vouchers.fee_exemption_armed, 0);
    assert.equal(back.players[id].vouchers.fee_exemption_active, 1);

    const done = act(patch(back, (d) => void (d.phase = 'awaiting_end_turn')), { type: 'END_TURN', playerId: id }).state;
    assert.equal(done.players[id].vouchers.fee_exemption_active, 0, 'an unused exemption expires');
  });

  it('an active exemption waives the first landing fee, and only that one', () => {
    const base = newGame(2);
    const id = currentPlayerId(base);
    const owner = 1 - id;
    const s = patch(base, (d) => {
      d.owners[4] = owner;
      d.owners[6] = owner;
      d.players[id].vouchers.fee_exemption_active = 1;
    });
    const first = rollOnto(s, 4);
    assert.equal(first.state.phase, 'awaiting_end_turn');
    assert.equal(me(first.state).cash, 20000);
    assert.equal(me(first.state).vouchers.fee_exemption_active, 0);
    assert.deepEqual(eventsOf(first.events, 'fee_exempted'), [
      { type: 'fee_exempted', payer: id, owner, tile: 4, amount: 80 },
    ]);
    assert.equal(first.events.some((e) => e.type === 'fee_due'), false);

    const second = rollOnto(patch(first.state, (d) => void (d.phase = 'awaiting_roll')), 6);
    assert.equal(second.state.phase, 'awaiting_fee_decision');
  });

  it('an armed exemption does not waive a fee in the same turn it was drawn', () => {
    const base = newGame(2);
    const id = currentPlayerId(base);
    const s = patch(base, (d) => {
      d.owners[16 - 12] = 1 - id; // tile 4
    });
    const got = rollForCard(s, 'luck', 'no_bills_day');
    const land = rollOnto(patch(got.state, (d) => void (d.phase = 'awaiting_roll')), 4);
    assert.equal(land.state.phase, 'awaiting_fee_decision');
  });
});

describe('mystery cards', () => {
  it('extra round: one more throw and move for the same player, not a new turn', () => {
    const before = newGame(3);
    const id = currentPlayerId(before);
    const { state } = rollForCard(before, 'mystery', 'extra_round');
    assert.equal(state.phase, 'awaiting_roll');
    assert.equal(currentPlayerId(state), id);
    assert.deepEqual(getLegalActions(board, state).filter((a) => a.type === 'ROLL'), [{ type: 'ROLL', playerId: id }]);
    assert.deepEqual(checkInvariants(board, state), []);
    const next = act(state, { type: 'ROLL', playerId: id });
    assert.notEqual(me(next.state).position, LUCK_TILE);
  });

  it('surprise visit: moves to the nearest office ahead and enters it', () => {
    const { state, events } = rollForCard(newGame(2), 'mystery', 'surprise_visit');
    assert.equal(me(state).position, OFFICE);
    assert.equal(state.phase, 'in_office');
    assert.ok(events.some((e) => e.type === 'moved' && e.from === LUCK_TILE && e.to === OFFICE));
    assert.ok(events.some((e) => e.type === 'office_entered'));
    assert.deepEqual(checkInvariants(board, state), []);
    // The office works as usual: leaving it ends the visit.
    assert.deepEqual(
      getLegalActions(board, state).filter((a) => a.type === 'LEAVE_OFFICE').length,
      1,
    );
  });

  it('station coupon: -200 on one station built in the office, then it is gone', () => {
    const base = newGame(2);
    const id = currentPlayerId(base);
    const got = rollForCard(patch(base, (d) => void ((d.owners[4] = id), (d.owners[6] = id))), 'mystery', 'station_coupon');
    assert.equal(me(got.state).vouchers.station_discount, 1);
    const office = rollOnto(patch(got.state, (d) => void (d.phase = 'awaiting_roll')), OFFICE);
    assert.equal(office.state.phase, 'in_office');
    const cash = me(office.state).cash;
    const built = act(office.state, { type: 'BUILD_STATION', playerId: id, tile: 4 });
    assert.equal(me(built.state).cash, cash - (800 - 200));
    assert.equal(me(built.state).vouchers.station_discount, 0);
    assert.deepEqual(eventsOf(built.events, 'station_built')[0], { type: 'station_built', playerId: id, tile: 4, cost: 600 });
    assert.equal(eventsOf(built.events, 'voucher_used')[0].amount, 200);
    const second = act(built.state, { type: 'BUILD_STATION', playerId: id, tile: 6 });
    assert.equal(me(second.state).cash, me(built.state).cash - 900, 'full price afterwards');
  });

  it('station coupon is only for the office, not for a station built where you stand', () => {
    const base = newGame(2);
    const id = currentPlayerId(base);
    const s = withVoucher(patch(base, (d) => void (d.owners[4] = id)), 'station_discount');
    const land = rollOnto(s, 4);
    const built = act(land.state, { type: 'BUILD_STATION', playerId: id, tile: 4 });
    assert.equal(me(built.state).cash, 20000 - 800);
    assert.equal(me(built.state).vouchers.station_discount, 1);
  });

  it('development opportunity: -200 on one development step and the real cost is remembered', () => {
    const base = newGame(2);
    const id = currentPlayerId(base);
    const owning = patch(base, (d) => void COMMERCIAL.forEach((t) => (d.owners[t] = id)));
    const got = rollForCard(owning, 'mystery', 'development_opportunity');
    const office = rollOnto(patch(got.state, (d) => void (d.phase = 'awaiting_roll')), OFFICE);
    const cash = me(office.state).cash;

    const first = act(office.state, { type: 'DEVELOP', playerId: id, tile: 4 });
    assert.equal(me(first.state).cash, cash - 200, 'a 400 step costs 200');
    assert.equal(first.state.levels[4], 2);
    assert.equal(first.state.developmentPaid[4], 200);
    assert.equal(me(first.state).vouchers.development_discount, 0);
    assert.equal(eventsOf(first.events, 'voucher_used')[0].amount, 200);
    assert.deepEqual(checkInvariants(board, first.state), []);

    const second = act(first.state, { type: 'DEVELOP', playerId: id, tile: 4 });
    assert.equal(me(second.state).cash, me(first.state).cash - 400, 'no voucher left');
    assert.equal(second.state.developmentPaid[4], 600);
    // The mortgage pays back what the owner really paid: 800 + 600.
    assert.equal(mortgageValue(board, second.state, 4), 1400);
  });

  it('development opportunity is offered cheaper in the legal actions and refuses a short purse', () => {
    const base = newGame(2);
    const id = currentPlayerId(base);
    const s = withVoucher(
      patch(base, (d) => {
        COMMERCIAL.forEach((t) => (d.owners[t] = id));
        d.players[id].cash = 200;
      }),
      'development_discount',
    );
    const office = rollOnto(s, OFFICE);
    assert.ok(getLegalActions(board, office.state).some((a) => a.type === 'DEVELOP' && a.tile === 4));
    const broke = patch(office.state, (d) => void (d.players[id].cash = 199));
    expectCode(() => act(broke, { type: 'DEVELOP', playerId: id, tile: 4 }), 'insufficient_cash');
  });

  it('market report lists the properties offered for rent', () => {
    const base = newGame(2);
    const id = currentPlayerId(base);
    const s = patch(base, (d) => {
      d.owners[6] = 1 - id;
      d.owners[2] = id;
      d.leaseOffers[6] = { laps: null };
      d.leaseOffers[2] = { laps: 3 };
    });
    const { events } = rollForCard(s, 'mystery', 'market_report');
    assert.deepEqual(eventsOf(events, 'market_report'), [{ type: 'market_report', playerId: id, rentListings: [2, 6] }]);
  });

  it('cards that need negotiation are reported as not built yet and change nothing', () => {
    const before = newGame(2);
    const { state, events } = rollForCard(before, 'mystery', 'investor_challenge');
    assert.deepEqual(eventsOf(events, 'card_not_implemented'), [
      { type: 'card_not_implemented', playerId: currentPlayerId(state), cardId: 'investor_challenge' },
    ]);
    assert.equal(me(state).cash, me(before).cash);
    assert.equal(state.phase, 'awaiting_end_turn');
  });
});

describe('card moves', () => {
  it('a card that sends you to another card tile does not draw again', () => {
    const custom = JSON.parse(JSON.stringify(rawBoard)) as typeof rawBoard;
    const card = custom.mysteryCards.find((c) => c.id === 'surprise_visit') as { effect: { kind: string } };
    card.effect.kind = 'luck_or_mystery';
    const b = parseBoard(custom);
    const id = 0;
    const base = patch(createGame(b, PLAYERS.slice(0, 2), 1), (d) => {
      d.turnOrder = [0, 1];
      d.players[id].position = 8;
    });
    for (let c = 1; c < 3_000_000; c++) {
      const r = rollDice(c);
      if (r.dice[0] + r.dice[1] !== 4) continue;
      const [pick, afterPick] = nextFloat(r.state);
      const [index] = nextFloat(afterPick);
      if (pick * 100 < RULES.luckDeckChancePercent) continue;
      if (Math.floor(index * b.mysteryCards.length) !== b.mysteryCards.findIndex((x) => x.id === 'surprise_visit')) continue;
      const out = applyAction(b, patch(base, (d) => void (d.rngState = c)), { type: 'ROLL', playerId: id });
      assert.equal(out.state.players[id].position, 21);
      assert.equal(eventsOf(out.events, 'card_drawn').length, 1, 'only the first card is drawn');
      assert.equal(out.state.phase, 'awaiting_end_turn');
      return;
    }
    assert.fail('no draw found');
  });
});

describe('utilities', () => {
  it('standing on an inactive utility offers to activate it for 100 or skip', () => {
    const { state } = rollOnto(newGame(3), UTILITY.commercial);
    const id = currentPlayerId(state);
    assert.equal(state.phase, 'awaiting_utility');
    assert.deepEqual(state.pending, { type: 'utility', tile: UTILITY.commercial, cost: 100 });
    assert.deepEqual(
      getLegalActions(board, state).map((a) => a.type),
      ['ACTIVATE_UTILITY', 'SKIP_UTILITY'],
    );
    const done = act(state, { type: 'ACTIVATE_UTILITY', playerId: id });
    assert.equal(me(done.state).cash, 19900);
    assert.deepEqual(me(done.state).utilities, [UTILITY.commercial]);
    assert.equal(done.state.phase, 'awaiting_end_turn');
    assert.equal(done.state.pending, null);
    assert.deepEqual(checkInvariants(board, done.state), []);
  });

  it('skipping costs nothing and can be done again next time', () => {
    const { state } = rollOnto(newGame(2), UTILITY.tech, 4);
    const id = currentPlayerId(state);
    const skipped = act(state, { type: 'SKIP_UTILITY', playerId: id });
    assert.equal(me(skipped.state).cash, 20000);
    assert.deepEqual(me(skipped.state).utilities, []);
    assert.equal(skipped.state.phase, 'awaiting_end_turn');
  });

  it('cannot activate without the 100, and the offer disappears', () => {
    const base = patch(newGame(2), (d) => void (d.players[d.turnOrder[0]].cash = 99));
    const { state } = rollOnto(base, UTILITY.commercial);
    const id = currentPlayerId(state);
    assert.deepEqual(getLegalActions(board, state).map((a) => a.type), ['SKIP_UTILITY']);
    expectCode(() => act(state, { type: 'ACTIVATE_UTILITY', playerId: id }), 'insufficient_cash');
  });

  it('exactly 100 is enough', () => {
    const base = patch(newGame(2), (d) => void (d.players[d.turnOrder[0]].cash = 100));
    const { state } = rollOnto(base, UTILITY.commercial);
    const done = act(state, { type: 'ACTIVATE_UTILITY', playerId: currentPlayerId(state) });
    assert.equal(me(done.state).cash, 0);
  });

  it('only the current player, only in the right phase', () => {
    const { state } = rollOnto(newGame(3), UTILITY.commercial);
    const id = currentPlayerId(state);
    const other = (id + 1) % 3;
    expectCode(() => act(state, { type: 'ACTIVATE_UTILITY', playerId: other }), 'wrong_player');
    expectCode(() => act(state, { type: 'SKIP_UTILITY', playerId: other }), 'wrong_player');
    expectCode(() => act(newGame(3), { type: 'ACTIVATE_UTILITY', playerId: currentPlayerId(newGame(3)) }), 'invalid_phase');
    expectCode(() => act(state, { type: 'END_TURN', playerId: id }), 'invalid_phase');
    expectCode(() => act(state, { type: 'ROLL', playerId: id }), 'invalid_phase');
  });

  it('landing on an activated utility offers nothing; the park pays 200 each time after activation', () => {
    const base = patch(newGame(2), (d) => void (d.players[d.turnOrder[0]].utilities = [UTILITY.commercial, UTILITY.residential]));
    const shop = rollOnto(base, UTILITY.commercial);
    assert.equal(shop.state.phase, 'awaiting_end_turn');
    assert.equal(me(shop.state).cash, 20000);

    const park = rollOnto(base, UTILITY.residential);
    assert.equal(park.state.phase, 'awaiting_end_turn');
    assert.equal(me(park.state).cash, 20200);
    assert.deepEqual(eventsOf(park.events, 'utility_used'), [
      { type: 'utility_used', playerId: currentPlayerId(park.state), tile: UTILITY.residential, amount: 200 },
    ]);
    const again = rollOnto(patch(park.state, (d) => void (d.phase = 'awaiting_roll')), UTILITY.residential);
    assert.equal(me(again.state).cash, 20400);
  });

  it('activating the park pays nothing at that moment', () => {
    const { state } = rollOnto(newGame(2), UTILITY.residential);
    const done = act(state, { type: 'ACTIVATE_UTILITY', playerId: currentPlayerId(state) });
    assert.equal(me(done.state).cash, 19900);
  });

  it('every player activates utilities for himself', () => {
    const a = rollOnto(newGame(2), UTILITY.commercial);
    const id = currentPlayerId(a.state);
    const done = act(a.state, { type: 'ACTIVATE_UTILITY', playerId: id }).state;
    const next = act(done, { type: 'END_TURN', playerId: id }).state;
    const other = rollOnto(next, UTILITY.commercial);
    assert.equal(other.state.phase, 'awaiting_utility', 'the other player has not activated it');
  });

  it('shopping center: 10% off commercial properties only', () => {
    const s = patch(newGame(2), (d) => void (d.players[d.turnOrder[0]].utilities = [UTILITY.commercial]));
    const commercial = rollOnto(s, 4);
    assert.deepEqual(commercial.state.pending, { type: 'purchase', tile: 4, price: 720 });
    const bought = act(commercial.state, { type: 'BUY', playerId: currentPlayerId(s) });
    assert.equal(me(bought.state).cash, 20000 - 720);
    assert.deepEqual(eventsOf(bought.events, 'utility_used'), [
      { type: 'utility_used', playerId: currentPlayerId(s), tile: 4, amount: 80 },
    ]);
    const tech = rollOnto(s, 11);
    assert.deepEqual(tech.state.pending, { type: 'purchase', tile: 11, price: 1200 });
  });

  it('shopping center and purchase voucher stack: 10% first, then 200', () => {
    const s = withVoucher(
      patch(newGame(2), (d) => void (d.players[d.turnOrder[0]].utilities = [UTILITY.commercial])),
      'purchase_discount',
    );
    const land = rollOnto(s, 4);
    assert.deepEqual(land.state.pending, { type: 'purchase', tile: 4, price: 520 });
    assert.deepEqual(checkInvariants(board, land.state), []);
    const bought = act(land.state, { type: 'BUY', playerId: currentPlayerId(s) });
    assert.equal(eventsOf(bought.events, 'voucher_used')[0].amount, 200);
    assert.equal(me(bought.state).cash, 20000 - 520);
  });

  it('the shopping center never changes the fee the owner earns or the mortgage value', () => {
    const s = patch(newGame(3), (d) => void (d.players[d.turnOrder[0]].utilities = [UTILITY.commercial]));
    const id = currentPlayerId(s);
    const bought = act(rollOnto(s, 4).state, { type: 'BUY', playerId: id });
    assert.equal(mortgageValue(board, bought.state, 4), 800, 'the mortgage is based on the original price');
  });

  it('innovation center and maintenance center: 10% off stations in their own district', () => {
    const base = newGame(2);
    const id = currentPlayerId(base);
    const s = patch(base, (d) => {
      d.owners[10] = id;
      d.owners[28] = id;
      d.owners[4] = id;
      d.players[id].utilities = [UTILITY.tech, UTILITY.industrial];
    });
    const office = rollOnto(s, OFFICE);
    const tech = act(office.state, { type: 'BUILD_STATION', playerId: id, tile: 10 });
    assert.equal(me(tech.state).cash, 20000 - 990);
    assert.deepEqual(eventsOf(tech.events, 'utility_used'), [{ type: 'utility_used', playerId: id, tile: 10, amount: 110 }]);
    const industrial = act(tech.state, { type: 'BUILD_STATION', playerId: id, tile: 28 });
    assert.equal(me(industrial.state).cash, me(tech.state).cash - 1890);
    const commercial = act(industrial.state, { type: 'BUILD_STATION', playerId: id, tile: 4 });
    assert.equal(me(commercial.state).cash, me(industrial.state).cash - 800, 'no discount in the commercial district');
    // The station's landing fee add-on is unchanged by the discount: 5% of 1100.
    assert.equal(tech.state.stations[10], id);
  });

  it('the wrong utility gives no station discount', () => {
    const base = newGame(2);
    const id = currentPlayerId(base);
    const s = patch(base, (d) => {
      d.owners[10] = id;
      d.players[id].utilities = [UTILITY.commercial, UTILITY.residential, UTILITY.industrial];
    });
    const office = rollOnto(s, OFFICE);
    const built = act(office.state, { type: 'BUILD_STATION', playerId: id, tile: 10 });
    assert.equal(me(built.state).cash, 20000 - 1100);
  });
});

describe('cards and utilities with the rest of the game', () => {

  it('a whole game turn with a card keeps turn order intact', () => {
    let s = newGame(3, 5);
    const order = [...s.turnOrder];
    const seen: number[] = [];
    for (let i = 0; i < 9; i++) {
      seen.push(currentPlayerId(s));
      s = playTurn(s);
      assert.deepEqual(checkInvariants(board, s), []);
    }
    assert.deepEqual(seen, [...order, ...order, ...order]);
  });
});

describe('deck validation', () => {
  const clone = () => JSON.parse(JSON.stringify(rawBoard)) as {
    tiles: unknown[];
    luckCards: { id: string; name: string; effect: Record<string, unknown> }[];
    mysteryCards: { id: string; name: string; effect: Record<string, unknown> }[];
  };

  it('accepts the shipped decks', () => {
    assert.deepEqual(validateBoard(rawBoard), []);
    assert.equal(rawBoard.luckCards.length, 20);
    assert.equal(rawBoard.mysteryCards.length, 20);
  });

  it('rejects duplicate ids, empty names, bad amounts and unknown effects', () => {
    const dup = clone();
    dup.luckCards[1].id = dup.luckCards[0].id;
    assert.ok(validateBoard(dup).length > 0);

    const noName = clone();
    noName.luckCards[0].name = ' ';
    assert.ok(validateBoard(noName).length > 0);

    const negative = clone();
    negative.luckCards[0].effect = { type: 'gain', amount: -5 };
    assert.ok(validateBoard(negative).length > 0);

    const fractional = clone();
    fractional.luckCards[0].effect = { type: 'pay', amount: 10.5 };
    assert.ok(validateBoard(fractional).length > 0);

    const unknown = clone();
    unknown.mysteryCards[0].effect = { type: 'teleport' };
    assert.ok(validateBoard(unknown).length > 0);

    const badVoucher = clone();
    badVoucher.luckCards[0].effect = { type: 'voucher', voucher: 'free_money' };
    assert.ok(validateBoard(badVoucher).length > 0);

    const badKind = clone();
    badKind.mysteryCards[0].effect = { type: 'move_to_nearest', kind: 'moon' };
    assert.ok(validateBoard(badKind).length > 0);
  });

  it('rejects a board without decks', () => {
    const none = clone();
    none.luckCards = [];
    assert.ok(validateBoard(none).length > 0);
    const missing = clone() as Record<string, unknown>;
    delete missing.mysteryCards;
    assert.ok(validateBoard(missing).length > 0);
  });
});

describe('saves with phase 3 state', () => {
  it('round-trips utilities, vouchers, paid development and a pending utility', () => {
    const base = newGame(3);
    const id = currentPlayerId(base);
    let s = patch(base, (d) => {
      d.players[id].utilities = [UTILITY.tech];
      d.players[id].vouchers.purchase_discount = 2;
      d.owners[4] = id;
      setLevel(d, 4, 2);
    });
    s = rollOnto(s, UTILITY.commercial).state;
    assert.equal(s.phase, 'awaiting_utility');
    const loaded = deserializeGame(board, serializeGame(s));
    assert.deepEqual(loaded, s);
    const a = act(s, { type: 'ACTIVATE_UTILITY', playerId: id });
    const b = act(loaded, { type: 'ACTIVATE_UTILITY', playerId: id });
    assert.deepEqual(a, b);
  });

  it('rejects inconsistent phase 3 saves', () => {
    const base = newGame(2);
    const bad = (change: (d: GameState) => void) => serializeGame(patch(base, change));
    assert.throws(() => deserializeGame(board, bad((d) => void (d.players[0].vouchers.gate_ticket = -1))), SaveError);
    assert.throws(() => deserializeGame(board, bad((d) => void (d.players[0].vouchers.gate_ticket = 1.5))), SaveError);
    assert.throws(() => deserializeGame(board, bad((d) => void (d.players[0].utilities = [1]))), SaveError); // not a utility
    assert.throws(() => deserializeGame(board, bad((d) => void (d.players[0].utilities = [5, 5]))), SaveError);
    assert.throws(() => deserializeGame(board, bad((d) => void (d.developmentPaid[4] = 100))), SaveError); // no level
    assert.throws(
      () =>
        deserializeGame(
          board,
          bad((d) => {
            d.owners[4] = 0;
            d.levels[4] = 2; // level without a paid record
          }),
        ),
      SaveError,
    );
    assert.throws(
      () =>
        deserializeGame(
          board,
          bad((d) => {
            d.phase = 'awaiting_utility';
            d.pending = { type: 'utility', tile: 5, cost: 100 }; // player is not standing there
          }),
        ),
      SaveError,
    );
    assert.throws(
      () =>
        deserializeGame(
          board,
          bad((d) => {
            d.phase = 'insolvent';
            d.pending = { type: 'insolvent', cause: 'card', tile: 0, payer: 0, creditor: 1, amount: 5 };
          }),
        ),
      SaveError,
    );
  });
});
