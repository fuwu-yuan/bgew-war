/** Viewport: portrait like the ad — map 640×960 + 64px HUD strip */
export const VIEW_W = 640;
export const VIEW_H = 1024;

/** Map grid */
export const TILE = 40;
export const GRID_W = 16; // 640
export const GRID_H = 24; // 960
export const MAP_H = GRID_H * TILE;

export const GAME_NAME = "BGEW WAR";
export const GAME_VERSION = "1.1.0";

/** Factions */
export const RED = 1;
export const BLUE = 2;
export type Faction = typeof RED | typeof BLUE;
export const enemyOf = (f: Faction): Faction => (f === RED ? BLUE : RED);

export const COLORS = {
  background: "#1d5e9e",
  ocean: "#2a72b8",
  oceanDeep: "#1d5e9e",
  shallow: "#5aa6dd",
  sand: "#eed592",
  sandDark: "#d9bc6e",
  cliff: "#c08a52",
  cliffDark: "#96673a",
  redTileA: "#f29eb4",
  redTileB: "#eb8aa4",
  blueTileA: "#79c0ec",
  blueTileB: "#62b2e4",
  redUnit: "#e8533f",
  blueUnit: "#3a9ade",
  bullet: "#fff4c2",
  text: "#ffffff",
  gold: "#ffd95e",
  hudBg: "#132b45",
  uiPanel: "rgba(10, 25, 45, 0.92)",
};

export const FONT = "'Black Ops One', sans-serif";

/** Costs (gold) */
export const COST = { barracks: 50, turret: 75, factory: 120, strike: 100 } as const;

/** Airstrike: radius and damage (hits BOTH sides — aim carefully) */
export const STRIKE_RADIUS = 75;
export const STRIKE_DMG_UNIT = 12;
export const STRIKE_DMG_BUILDING = 10;
export const STRIKE_DELAY = 0.9; // s between the warning marker and the blast

/** Soldier upgrades: level 1 (base) → MAX_SOLDIER_LEVEL */
export const MAX_SOLDIER_LEVEL = 5;
/** Gold cost to reach `level + 1` from `level`, null at max */
export function upgradeCost(level: number): number | null {
  return level >= MAX_SOLDIER_LEVEL ? null : 80 * level;
}

/** Caps to keep 60 fps on phones */
export const MAX_SOLDIERS = 70;
export const MAX_TANKS = 8;

export interface BestStats {
  wins: number;
  bestTime: number; // seconds, fastest victory
}

const STORAGE_KEY = "bgew-war.best";

export function loadBest(): BestStats | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as BestStats) : null;
  } catch {
    return null;
  }
}

export function saveBest(b: BestStats): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
  } catch {
    /* private navigation: ignore */
  }
}
