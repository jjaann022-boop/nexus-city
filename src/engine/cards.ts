import { TILE_KINDS } from './types.ts';
import type { TileKind } from './types.ts';

const LUCK_VOUCHERS = ['purchase_discount', 'gate_ticket', 'fee_exemption', 'card_payment_exemption'];
const MYSTERY_VOUCHERS = ['station_discount', 'development_discount'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isMoney = (v: unknown): boolean => Number.isInteger(v) && (v as number) > 0;

function effectProblems(deck: 'luckCards' | 'mysteryCards', effect: unknown): string[] {
  if (!isRecord(effect) || typeof effect.type !== 'string') return ['effect must be an object with a type'];
  const type = effect.type;
  if (deck === 'luckCards') {
    switch (type) {
      case 'gain':
      case 'pay':
        return isMoney(effect.amount) ? [] : [`${type} needs a positive whole amount`];
      case 'gain_if_owns_property':
        return isMoney(effect.amount) && isMoney(effect.otherwise)
          ? []
          : ['gain_if_owns_property needs positive whole amount and otherwise'];
      case 'voucher':
        return LUCK_VOUCHERS.includes(effect.voucher as string) ? [] : [`unknown luck voucher ${String(effect.voucher)}`];
      default:
        return [`unknown luck effect ${type}`];
    }
  }
  switch (type) {
    case 'extra_roll':
    case 'market_report':
    case 'not_implemented':
      return [];
    case 'move_to_nearest':
      return TILE_KINDS.includes(effect.kind as TileKind) ? [] : [`unknown tile kind ${String(effect.kind)}`];
    case 'voucher':
      return MYSTERY_VOUCHERS.includes(effect.voucher as string)
        ? []
        : [`unknown mystery voucher ${String(effect.voucher)}`];
    default:
      return [`unknown mystery effect ${type}`];
  }
}

/** Returns a list of problems with a deck; an empty list means it is valid. */
export function validateDeck(raw: unknown, deck: 'luckCards' | 'mysteryCards'): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return [`${deck} must be a non-empty array`];
  const errors: string[] = [];
  const ids = new Set<string>();
  raw.forEach((card: unknown, i) => {
    const where = `${deck}[${i}]`;
    if (!isRecord(card)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    if (typeof card.id !== 'string' || card.id.trim() === '') errors.push(`${where}: id is required`);
    else if (ids.has(card.id)) errors.push(`${where}: duplicate id ${card.id}`);
    else ids.add(card.id);
    if (typeof card.name !== 'string' || card.name.trim() === '') errors.push(`${where}: name is required`);
    for (const problem of effectProblems(deck, card.effect)) errors.push(`${where}: ${problem}`);
  });
  return errors;
}
