import { EngineError } from './errors.ts';
import { DISTRICTS } from './types.ts';
import type { Board, District, Tile, TileKind } from './types.ts';

/** A roll is at most 12, so with 13+ tiles one roll can never pass the gate twice. */
export const MIN_TILES = 13;

const TILE_KINDS: readonly TileKind[] = [
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

// Corners and the real estate office: exactly one each, never inside a district.
const UNIQUE_KINDS: readonly TileKind[] = [
  'gate',
  'municipality',
  'financial_center',
  'transport_center',
  'real_estate_office',
];

type DistrictKind = 'property' | 'luck_or_mystery' | 'utility' | 'city_project';
const DISTRICT_KINDS: readonly DistrictKind[] = ['property', 'luck_or_mystery', 'utility', 'city_project'];

// Brief §3: each district has 5 properties, a luck/mystery tile, one utility, one city project.
const PER_DISTRICT: Record<DistrictKind, number> = {
  property: 5,
  luck_or_mystery: 1,
  utility: 1,
  city_project: 1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns a list of problems; an empty list means the board is valid. */
export function validateBoard(raw: unknown): string[] {
  if (!isRecord(raw)) return ['board must be an object'];
  const errors: string[] = [];

  const meta = raw.meta;
  if (!isRecord(meta) || typeof meta.temporary !== 'boolean' || typeof meta.note !== 'string') {
    errors.push('board.meta must be { temporary: boolean, note: string }');
  }
  if (!Array.isArray(raw.tiles)) {
    errors.push('board.tiles must be an array');
    return errors;
  }

  const tiles = raw.tiles as unknown[];
  if (tiles.length < MIN_TILES) {
    errors.push(`board needs at least ${MIN_TILES} tiles so one roll can never pass the gate twice`);
  }

  let shapeOk = true;
  tiles.forEach((t, i) => {
    const where = `tile ${i}`;
    if (!isRecord(t)) {
      errors.push(`${where}: must be an object`);
      shapeOk = false;
      return;
    }
    if (typeof t.name !== 'string' || t.name.trim() === '') {
      errors.push(`${where}: name is required`);
      shapeOk = false;
    }
    if (typeof t.kind !== 'string' || !TILE_KINDS.includes(t.kind as TileKind)) {
      errors.push(`${where}: unknown kind ${String(t.kind)}`);
      shapeOk = false;
      return;
    }
    const kind = t.kind as TileKind;

    if (kind === 'property') {
      const price = t.price;
      if (!Number.isInteger(price) || (price as number) <= 0 || (price as number) % 10 !== 0) {
        errors.push(`${where}: property price must be a positive multiple of 10 (so 10% rent and discounts and 50% steps stay whole liras)`);
        shapeOk = false;
      }
    } else if (t.price !== undefined) {
      errors.push(`${where}: only properties have a price`);
      shapeOk = false;
    }

    if ((DISTRICT_KINDS as readonly string[]).includes(kind)) {
      if (!DISTRICTS.includes(t.district as District)) {
        errors.push(`${where}: ${kind} needs a valid district`);
        shapeOk = false;
      }
    } else if (t.district !== undefined) {
      errors.push(`${where}: ${kind} must not belong to a district`);
      shapeOk = false;
    }
  });
  if (!shapeOk) return errors;

  const typed = tiles as Tile[];
  if (typed.length > 0 && typed[0].kind !== 'gate') {
    errors.push('tile 0 must be the gate (all players start there)');
  }
  for (const kind of UNIQUE_KINDS) {
    const count = typed.filter((t) => t.kind === kind).length;
    if (count !== 1) errors.push(`there must be exactly one ${kind} tile (found ${count})`);
  }
  for (const district of DISTRICTS) {
    for (const kind of DISTRICT_KINDS) {
      const count = typed.filter((t) => t.district === district && t.kind === kind).length;
      if (count !== PER_DISTRICT[kind]) {
        errors.push(`district ${district} needs exactly ${PER_DISTRICT[kind]} ${kind} tile(s) (found ${count})`);
      }
    }
  }
  return errors;
}

/** Validates untrusted data (for example a JSON file) and returns it as a Board. */
export function parseBoard(raw: unknown): Board {
  const errors = validateBoard(raw);
  if (errors.length > 0) throw new EngineError('invalid_board', errors.join('; '));
  return raw as Board;
}
