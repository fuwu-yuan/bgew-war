import type { TileMap } from "./entities/tilemap";
import type { Unit } from "./entities/units";
import type { Building } from "./entities/buildings";
import type { Helicopter } from "./entities/helicopter";
import type { Faction } from "./globals";

export type Target = Unit | Building | Helicopter;

/** What units, bullets and buildings are allowed to ask the game step. */
export interface GameAPI {
  map: TileMap;
  /** X (px) of the attack axis the faction converges on. */
  axisX(f: Faction): number;
  /** Vertical orientation: +1 in host space, -1 when the view is mirrored
   *  (guest). Multiply any "RED goes down / BLUE goes up" direction by this. */
  flipY(): number;
  /** Closest living enemy unit or building within `range` px. */
  nearestEnemy(x: number, y: number, f: Faction, range: number): Target | null;
  /** Closest living enemy helicopter within `range` px (anti-air : tourelles/QG). */
  nearestAirEnemy(x: number, y: number, f: Faction, range: number): Target | null;
  fireBullet(x: number, y: number, target: Target, dmg: number, f: Faction, big: boolean): void;
  spawnSoldier(f: Faction, x: number, y: number, level?: number): void;
  spawnTank(f: Faction, x: number, y: number, level?: number): void;
  /** Convert the tile under (x, y) — gold, flash and sound handled inside. */
  tryConvert(x: number, y: number, f: Faction): void;
  /** Impact/explosion particles at (x, y). */
  impact(x: number, y: number, big: boolean): void;
  notifyKill(victim: Target, killer: Faction): void;
  sfx(name: string, volume?: number): void;
}
