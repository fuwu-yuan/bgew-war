/**
 * Difficulté de l'IA solo — réglages + persistance du choix du joueur.
 *
 * Règle d'or : l'IA NE TRICHE JAMAIS. Aucun niveau ne lui donne plus d'or,
 * plus de revenus ou des unités gratuites que le joueur n'aurait pas.
 * Chaque cran est soit un handicap (or de départ réduit, réflexion lente,
 * hésitations), soit une décision plus intelligente (anticipation des
 * frappes, lecture des habitudes du joueur, combos économisés). Le revenu
 * de base est identique des deux côtés à tous les niveaux.
 */

export type Difficulty = "easy" | "medium" | "hard" | "insane";
export const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard", "insane"];

export interface AiTuning {
  /** Nom affiché (HUD "IA …" + bouton du menu). */
  label: string;
  /** Accent du bouton dans le menu. */
  color: string;
  /** Or de départ de l'IA — toujours ≤ aux 80 du joueur (handicap, jamais bonus). */
  startGold: number;
  /** s avant que l'IA ne commence à dépenser (laisse l'initiative au joueur). */
  grace: number;
  /** s entre deux plans — sa vitesse de réflexion. */
  brainEvery: number;
  /** Ordres qu'un même plan peut enchaîner (son "APM"). */
  actionsPerPlan: number;
  /** Chance qu'un plan hésite et ne fasse rien (bas niveaux). */
  skipChance: number;
  /** Chance que l'axe d'attaque dérive au hasard au lieu de la meilleure colonne. */
  axisJitter: number;
  /** Or gardé en banque pour frapper/réagir : les constructions n'y touchent
   *  pas. C'est LE levier de force — les frappes gagnent les guerres, et une
   *  IA qui vide sa banque dans des bâtiments de front ne frappe jamais. */
  bank: number;
  /** Équivalents-soldats groupés (tank = 2.5) pour qu'une frappe vaille 100 d'or. */
  strikeMinPack: number;
  /** Vise devant un groupe en marche (compense la mèche de 0.9 s). */
  strikeLead: boolean;
  /** Lit les habitudes du joueur (ordres visibles à l'écran) et les contre. */
  adapt: boolean;
  /** Économise pour des combos frappe + hélico + bascule d'axe. */
  combo: boolean;
  /** Chance par plan de lancer un hélico quand la DCA adverse est faible. */
  heliChance: number;
  /** s entre deux sondages de menace sur son QG (réflexe défensif). */
  panicEvery: number;
  /** Soldats par garnison d'urgence — payés 10 d'or pièce, jamais gratuits. */
  garrison: number;
  maxTurrets: number;
  maxFactories: number;
  /** Plafond de casernes : base, puis +1 toutes les rampEvery secondes. */
  barracksBase: number;
  barracksRampEvery: number;
  barracksMax: number;
}

export const AI_TUNING: Record<Difficulty, AiTuning> = {
  easy: {
    label: "FACILE",
    color: "#7fe08a",
    startGold: 30,
    grace: 14,
    brainEvery: 5,
    actionsPerPlan: 1,
    skipChance: 0.35,
    axisJitter: 0.55,
    bank: 0,
    strikeMinPack: 8,
    strikeLead: false,
    adapt: false,
    combo: false,
    heliChance: 0.15,
    panicEvery: 1.1,
    garrison: 3,
    maxTurrets: 3,
    maxFactories: 1,
    barracksBase: 3,
    barracksRampEvery: 150,
    barracksMax: 4,
  },
  medium: {
    label: "MOYEN",
    color: "#ffe27a",
    startGold: 60,
    grace: 8,
    brainEvery: 3,
    actionsPerPlan: 1,
    skipChance: 0.12,
    axisJitter: 0.35,
    bank: 60,
    strikeMinPack: 5,
    strikeLead: false,
    adapt: false,
    combo: false,
    heliChance: 0.38,
    panicEvery: 0.4,
    garrison: 5,
    maxTurrets: 6,
    maxFactories: 2,
    barracksBase: 4,
    barracksRampEvery: 90,
    barracksMax: 6,
  },
  hard: {
    label: "DIFFICILE",
    color: "#ffb13d",
    startGold: 80,
    grace: 5,
    brainEvery: 1.6,
    actionsPerPlan: 2,
    skipChance: 0.03,
    axisJitter: 0.15,
    bank: 120,
    strikeMinPack: 5,
    strikeLead: true,
    adapt: true,
    combo: false,
    heliChance: 0.5,
    panicEvery: 0.35,
    garrison: 6,
    maxTurrets: 8,
    maxFactories: 3,
    barracksBase: 5,
    barracksRampEvery: 75,
    barracksMax: 7,
  },
  insane: {
    label: "IMBATTABLE",
    color: "#ff6a5a",
    startGold: 80,
    grace: 2,
    brainEvery: 0.8,
    actionsPerPlan: 3,
    skipChance: 0,
    axisJitter: 0.05,
    bank: 140,
    strikeMinPack: 4,
    strikeLead: true,
    adapt: true,
    combo: true,
    heliChance: 0.6,
    panicEvery: 0.25,
    garrison: 8,
    maxTurrets: 10,
    maxFactories: 4,
    barracksBase: 6,
    barracksRampEvery: 60,
    barracksMax: 9,
  },
};

/** Casernes autorisées à `elapsed` secondes de jeu. */
export function barracksCap(t: AiTuning, elapsed: number): number {
  return Math.min(t.barracksMax, t.barracksBase + Math.floor(elapsed / t.barracksRampEvery));
}

const DIFF_KEY = "bgew-war.difficulty";

export function loadDifficulty(): Difficulty {
  try {
    const v = localStorage.getItem(DIFF_KEY) as Difficulty | null;
    return v && DIFFICULTIES.includes(v) ? v : "medium";
  } catch {
    return "medium";
  }
}

export function saveDifficulty(d: Difficulty): void {
  try {
    localStorage.setItem(DIFF_KEY, d);
  } catch {
    /* navigation privée : ignore */
  }
}
