/** Viewport: portrait like the ad — map + two-row command HUD */
export const VIEW_W = 640;
export const VIEW_H = 1024;

/** Map grid */
export const TILE = 40;
export const GRID_W = 16; // 640
export const GRID_H = 22; // 880
export const MAP_H = GRID_H * TILE;

export const GAME_NAME = "BGEW WAR";
export const GAME_VERSION = "1.2.0";

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
export const COST = { barracks: 50, turret: 75, factory: 120, strike: 100, helico: 150 } as const;

/** Sortie d'hélico : traverse la carte, mitraille, revient. Ne convertit
 * pas les tuiles ; seuls TOURELLES et QG peuvent le toucher (anti-air). */
export const HELI_HP = 28;
export const HELI_DMG = 5;
export const HELI_RANGE = 130;
export const HELI_FIRE_PERIOD = 0.24;
export const HELI_SPEED = 92; // px/s
export const MAX_HELIS = 3; // sorties simultanées par faction

/** Airstrike: radius and damage (hits BOTH sides — aim carefully) */
export const STRIKE_RADIUS = 75;
export const STRIKE_DMG_UNIT = 12;
export const STRIKE_DMG_BUILDING = 10;
export const STRIKE_DELAY = 0.9; // s between the warning marker and the blast

/** Upgrade costs to reach `level + 1` from `level`. No max level. */
export function soldierUpgradeCost(level: number): number {
  return Math.round(80 * Math.pow(level, 1.18));
}

export function tankUpgradeCost(level: number): number {
  return Math.round(120 * Math.pow(level, 1.2));
}

export function turretUpgradeCost(level: number): number {
  return Math.round(100 * Math.pow(level, 1.2));
}

/** Caps to keep 60 fps on phones while allowing wave-based production. */
export const MAX_SOLDIERS = 320;
export const MAX_TANKS = 48;

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
