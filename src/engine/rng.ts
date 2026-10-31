// Seeded, pure random numbers (mulberry32). The generator state lives inside the
// game state, so a saved game or an online room replays identically everywhere.

/** Returns a float in [0, 1) and the next generator state. */
export function nextFloat(state: number): [number, number] {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, next];
}

export function rollDie(state: number): { value: number; state: number } {
  const [f, next] = nextFloat(state);
  return { value: Math.floor(f * 6) + 1, state: next };
}

export function rollDice(state: number): { dice: [number, number]; state: number } {
  const a = rollDie(state);
  const b = rollDie(a.state);
  return { dice: [a.value, b.value], state: b.state };
}
