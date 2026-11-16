/**
 * Difficulté de l'IA solo — réglages + persistance du choix du joueur.
 *
 * Règle d'or : l'IA NE TRICHE JAMAIS. Elle joue par le même chemin de
 * commandes qu'un humain (src/commander.ts) : même or, mêmes prix, mêmes
 * validations, aucune unité gratuite. Chaque cran est soit un handicap (or
 * de départ réduit, réflexion lente, hésitations, doctrine de débutant),
 * soit une meilleure doctrine (celle issue de l'auto-jeu, src/trained.ts).
 */
import { BASE_GENOME, Genome, sanitizeGenome } from "./commander";
import { TRAINED_GENOME } from "./trained";

export type Difficulty = "easy" | "medium" | "hard" | "insane" | "claude";
export const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard", "insane", "claude"];

/** Niveau CLAUDE : le général rouge est un vrai modèle Claude (Anthropic),
 *  interrogé via la Cloud Function `claudeTurn`. Privé pour le moment :
 *  protégé par mot de passe (vérifié côté serveur, jamais dans le bundle). */
export const CLAUDE_DIFFICULTY: Difficulty = "claude";

export interface AiTuning {
  /** Nom affiché (HUD "IA …" + bouton du menu). */
  label: string;
  /** Accent du bouton dans le menu. */
  color: string;
  /** Or de départ de l'IA sur la base historique de 80 — toujours ≤ au joueur (handicap, jamais bonus). */
  startGold: number;
  /** s avant que l'IA ne commence à dépenser (laisse l'initiative au joueur). */
  grace: number;
  /** s entre deux réflexions du commandant (au plus un achat par réflexion). */
  brainEvery: number;
  /** Chance qu'une réflexion hésite et ne fasse rien (bas niveaux). */
  skipChance: number;
  /** Doctrine du commandant : celle issue de l'auto-jeu, ou la doctrine de base. */
  genome: "trained" | "base";
  /** Retouches de doctrine propres au niveau (ex. le niveau facile n'utilise ni frappe ni hélico). */
  tweak?: (g: Genome) => void;
  /** Niveau verrouillé par mot de passe (menu). */
  locked?: boolean;
}

export const AI_TUNING: Record<Difficulty, AiTuning> = {
  easy: {
    label: "FACILE",
    color: "#7fe08a",
    startGold: 30,
    grace: 14,
    brainEvery: 7,
    skipChance: 0.4,
    genome: "base",
    // un débutant : ni frappe ni hélico, peu de niveaux, tout sur le front
    tweak: (g) => {
      g.w.strike = 0;
      g.w.heli = 0;
      g.w.soldierAtk *= 0.5;
      g.w.soldierDef *= 0.5;
      g.backMin = 0;
      g.vsTanks = g.vsMass = g.vsAir = 1;
    },
  },
  medium: {
    label: "MOYEN",
    color: "#ffe27a",
    startGold: 60,
    grace: 8,
    brainEvery: 4,
    skipChance: 0.15,
    genome: "base",
  },
  hard: {
    label: "DIFFICILE",
    color: "#ffb13d",
    startGold: 80,
    grace: 4,
    brainEvery: 1.5,
    skipChance: 0,
    genome: "trained",
  },
  insane: {
    label: "IMBATTABLE",
    color: "#ff6a5a",
    startGold: 80,
    grace: 0,
    brainEvery: 0.5,
    skipChance: 0,
    genome: "trained",
  },
  // Le commandant entraîné joue seul, au rythme du niveau imbattable ; le
  // général Claude ajuste sa doctrine en cours de partie (voir claude-general.ts).
  claude: {
    label: "CLAUDE",
    color: "#d97757",
    startGold: 80,
    grace: 0,
    brainEvery: 0.5,
    skipChance: 0,
    genome: "trained",
    locked: true,
  },
};

/** Doctrine de départ du commandant pour ce niveau (copie indépendante). */
export function genomeFor(t: AiTuning): Genome {
  const g = sanitizeGenome(t.genome === "trained" ? TRAINED_GENOME : BASE_GENOME);
  t.tweak?.(g);
  return sanitizeGenome(g);
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
