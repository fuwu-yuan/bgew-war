import { makeRng } from "./utils";

/**
 * ONE shared PRNG for the whole simulation, seeded per match (the host mints the
 * seed and sends it to the guest). Because both clients seed identically and run
 * the same sim logic in the same order, they draw the same random sequence — the
 * basis for the lockstep branch.
 *
 * IMPORTANT: only SIM code may call these. Cosmetic randomness (particles, walk
 * animation, sound variants, menus) must keep using Math.random / rand(), or it
 * would consume the sim sequence and break determinism between clients.
 */
let rng: () => number = Math.random;

/** Reseed the simulation RNG (call once at match start, before any sim draw). */
export function seedSim(seed: number): void {
  rng = makeRng(seed >>> 0);
}

/** Seeded float in [min, max). */
export function srand(min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Seeded integer in [min, max]. */
export function srandInt(min: number, max: number): number {
  return Math.floor(min + rng() * (max - min + 1));
}

/** Seeded element of an array. */
export function spick<T>(arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
