/**
 * BALANCE — tous les chiffres de gameplay au même endroit.
 *
 * C'est la seule source de vérité de l'équilibrage : unités, bâtiments,
 * économie, frappes, hélicos, améliorations. Les entités lisent `BAL` au
 * moment où elles en ont besoin, jamais de copie figée ailleurs.
 *
 * L'objet est volontairement MUTABLE : le banc d'équilibrage
 * (tools/balance-lab.mjs) le modifie à chaud via `window.__bgewwar.balance`
 * pour comparer des variantes sans recompiler. En jeu, personne n'y touche :
 * les deux clients d'une partie en ligne chargent le même bundle, donc les
 * mêmes valeurs (condition du lockstep).
 */
export const BAL = {
  /** Or : revenu passif par seconde, par case conquise, par coffre. */
  /** Or de départ de chaque camp (l'IA des bas niveaux en reçoit une fraction : handicap). */
  startGold: 120,
  income: 3,
  tileGold: 1,
  chestGold: 25,
  /** Prime versée au tueur. */
  bounty: { soldier: 0.75, tank: 6, heli: 15, barracks: 20, turret: 25, factory: 30 },

  /** Prix des ordres. */
  cost: { barracks: 50, turret: 60, factory: 120, strike: 60, helico: 100 },

  /**
   * Prix croissant des bâtiments : les `free` premiers (vivants) sont au prix
   * de base, chaque suivant coûte × `mult`. Produire toujours plus rapporte de
   * moins en moins, donc tourelles, frappes, hélicos et niveaux deviennent de
   * vrais choix. Le prix RETOMBE quand un bâtiment est détruit : rebâtir après
   * une défaite est bon marché (anti boule de neige).
   */
  costGrowth: {
    barracks: { free: 3, mult: 1.35 },
    factory: { free: 0, mult: 1.5 },
    turret: { free: 3, mult: 1.15 },
  },

  /**
   * Améliorations : 4 branches (soldats, tanks, tourelles, hélicos) × 2 voies
   * (atk = force, def = défense), achetées séparément. Prix pour passer de
   * `level` à `level + 1` : base × level^exp.
   */
  upgrade: {
    soldier: { atk: { base: 60, exp: 1.35 }, def: { base: 60, exp: 1.35 } },
    tank: { atk: { base: 70, exp: 1.3 }, def: { base: 70, exp: 1.3 } },
    turret: { atk: { base: 60, exp: 1.2 }, def: { base: 50, exp: 1.2 } },
    heli: { atk: { base: 60, exp: 1.3 }, def: { base: 60, exp: 1.3 } },
  },

  soldier: {
    hp: 10,
    dmg: 1,
    range: 90,
    firePeriod: 1,
    speedMin: 48,
    speedMax: 62,
    /** Gain par niveau au-dessus de 1. FORCE : dmg, range, fire (multiplicateur
     *  de période). DÉFENSE : hp, speed. */
    up: { hp: 3, dmg: 0.25, range: 4, fire: 0.96, speed: 3 },
  },
  tank: {
    hp: 95,
    dmg: 5,
    range: 150,
    firePeriod: 1.3,
    speed: 30,
    up: { hp: 16, dmg: 1, range: 6, fire: 0.94, speed: 2 },
    /** Rayon (px) des éclats d'obus autour de la cible. 0 = tir simple. */
    splash: 0,
  },
  /** Part des dégâts d'un obus infligée aux voisins de la cible. */
  splashFrac: 0.5,

  /** Le QG est une forteresse qui riposte. */
  hq: { hp: 2600, range: 170, dmg: 6, firePeriod: 0.35, splash: 40 },
  barracks: { hp: 240, spawnEvery: 8, waveCount: 12, waveSpacing: 0.18, buildTime: 3 },
  factory: { hp: 320, spawnEvery: 12, waveCount: 4, waveSpacing: 0.45, buildTime: 5 },
  turret: {
    hp: 480,
    range: 150,
    dmg: 4,
    firePeriod: 0.25,
    buildTime: 4,
    /** Gain par niveau au-dessus de 1. FORCE : +range px, +dmg (fraction),
     *  période × fire. DÉFENSE : +hp (fraction des pv de base). */
    up: { range: 10, dmg: 0.42, fire: 0.88, hp: 0.3 },
  },
  /** Un chantier démarre à cette fraction de ses pv. */
  siteHp: 0.3,

  /** Frappe aérienne : touche LES DEUX camps dans le rayon. `cooldown` = temps de
   *  rechargement (s) entre deux frappes d'un même camp : pas de bombardement en chaîne. */
  strike: { radius: 105, dmgUnit: 16, dmgBuilding: 120, delay: 0.9, cooldown: 20 },

  /** Hélico d'appui : ralentit (× strafeSlow) tant qu'il a une cible, `fuel` s
   *  d'autonomie à l'aller, demi-tour à `turnBack` px du bord adverse (il
   *  n'entre pas dans la base). Seuls tourelles et QG le touchent. */
  heli: { hp: 80, dmg: 7, range: 130, firePeriod: 0.12, speed: 92, max: 3, turnBack: 250, fuel: 22, strafeSlow: 0.2,
    /** Gain par niveau : FORCE +dmg (fraction), DÉFENSE +hp (fraction). */
    up: { dmg: 0.25, hp: 0.3 } },

  /**
   * Vagues de défense du QG : `waves` par partie et par camp, déclenchées par
   * paliers de pv (1re au premier coup reçu, puis à chaque tranche perdue).
   * Chaque siège donne au défenseur une vraie chance de repousser l'assaut.
   */
  hqDefense: { waves: 2, radius: 340, minSoldiers: 24, maxSoldiers: 70, minTanks: 2, maxTanks: 6 },

  /**
   * Mort subite : passé `start` secondes, le QG du camp qui tient le MOINS de
   * territoire perd `dps` pv/s (× 2 chaque `doubleEvery` s). Aucune partie ne
   * peut s'éterniser, et le territoire reste l'enjeu jusqu'au bout.
   */
  suddenDeath: { start: 360, dps: 8, doubleEvery: 60 },

  /** Largeur de l'armée : chaque unité marche à ±laneSpread px de l'axe d'attaque. */
  laneSpread: 260,

  /** À moins de cette distance verticale (px) du QG adverse, les unités convergent sur lui. */
  siegeRadius: 220,

  /** Plafonds d'unités vivantes par camp (60 fps sur mobile). */
  maxSoldiers: 320,
  maxTanks: 48,
};

export type Balance = typeof BAL;

export type UpgradeKind = "soldier" | "tank" | "turret" | "heli";
/** Voie d'amélioration : force (atk) ou défense (def). */
export type UpgradeStat = "atk" | "def";
export const UPGRADE_KINDS: UpgradeKind[] = ["soldier", "tank", "turret", "heli"];
export interface UpLevels {
  atk: number;
  def: number;
}

export type BuildKind = "barracks" | "factory" | "turret";

/** Prix du prochain bâtiment de ce type quand le camp en possède déjà `owned`. */
export function buildCost(kind: BuildKind, owned: number): number {
  const g = BAL.costGrowth[kind];
  return Math.round(BAL.cost[kind] * Math.pow(g.mult, Math.max(0, owned - g.free)));
}

/** Prix pour passer de `level` à `level + 1` dans cette branche et cette voie. */
export function upgradeCost(kind: UpgradeKind, stat: UpgradeStat, level: number): number {
  const u = BAL.upgrade[kind][stat];
  return Math.round(u.base * Math.pow(level, u.exp));
}
