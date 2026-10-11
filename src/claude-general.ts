/**
 * Niveau CLAUDE — pont client vers le général (Cloud Function `claudeTurn`).
 *
 * Le modèle ne voit que ce que le joueur voit (carte, bâtiments, unités,
 * niveaux, ordres visibles) et répond par des INTENTIONS. Le lieutenant local
 * (game.step.ts) les exécute avec les règles et l'or communs à tous.
 *
 * Le mot de passe est demandé au menu, vérifié côté serveur (`ping`) puis
 * mémorisé en localStorage. La clé API Anthropic n'existe que dans la
 * fonction : rien de secret dans ce bundle.
 */
import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";

export type ClaudeOrderType = "caserne" | "tourelle" | "usine" | "frappe" | "helico" | "amelioration";
export type ClaudeTarget = "groupe" | "batiment" | "colonne" | "aucune";
export type ClaudeUpgrade = "soldats" | "tanks" | "tourelles" | "aucune";

export interface ClaudeOrder {
  type: ClaudeOrderType;
  col: number; // -1 = sans objet
  ligne: number; // -1 = sans objet
  cible: ClaudeTarget;
  quoi: ClaudeUpgrade;
}

export interface ClaudePlan {
  analyse: string;
  message: string;
  axe: number;
  reserve: number;
  ordres: ClaudeOrder[];
}

export interface ClaudeBuildingInfo {
  type: "hq" | "barracks" | "turret" | "factory";
  c: number;
  r: number;
  hp: number; // 0..1
  building: boolean; // chantier en cours
}

/** L'état envoyé au général : strictement ce qui est visible à l'écran. */
export interface ClaudeState {
  turn: number;
  t: number;
  gold: number; // or ROUGE (le sien)
  share: number; // part de territoire rouge 0..1
  axis: number;
  reserve: number;
  levels: { red: ClaudeLevels; blue: ClaudeLevels };
  upgradeCost: { soldiers: number; tanks: number; turrets: number };
  units: { red: { soldiers: number; tanks: number }; blue: { soldiers: number; tanks: number } };
  helis: { red: number; blue: number };
  hq: { red: number; blue: number }; // pv 0..1
  map: string[]; // 22 lignes × 16 caractères
  cols: { blueFront: number[]; red: number[]; blue: number[] };
  redBuildings: ClaudeBuildingInfo[];
  blueBuildings: ClaudeBuildingInfo[];
  habits: { strikes: number; helis: number; upSoldier: number; upTank: number; upTurret: number; favoredCol: number };
  deepestBlueRow: number;
  pending: string[];
  lieutenant: string;
}

export interface ClaudeLevels {
  soldiers: number;
  tanks: number;
  turrets: number;
}

/** Une décision passée et ce qu'elle a donné (mémoire courte du général). */
export interface ClaudeJournalEntry {
  t: number;
  axe: number;
  reserve: number;
  message: string;
  faits: string[];
  ignores: string[];
  partAvant: number;
  partApres: number;
  orAvant: number;
  orApres: number;
}

export interface ClaudeTurnResult {
  plan: ClaudePlan;
  latencyMs: number;
  model?: string;
}

const PASS_KEY = "bgew-war.claude-pass";

export function loadClaudePassword(): string {
  try {
    return localStorage.getItem(PASS_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveClaudePassword(p: string): void {
  try {
    if (p) localStorage.setItem(PASS_KEY, p);
    else localStorage.removeItem(PASS_KEY);
  } catch {
    /* navigation privée : ignore */
  }
}

/** Erreur typée pour que l'appelant distingue « mauvais mot de passe » d'une panne. */
export class ClaudeError extends Error {
  constructor(
    public code: "password" | "quota" | "unavailable" | "unknown",
    message: string
  ) {
    super(message);
  }
}

function toClaudeError(e: unknown): ClaudeError {
  if (e instanceof ClaudeError) return e;
  const fe = e as FirebaseError | undefined;
  const code = fe && typeof fe.code === "string" ? fe.code : "";
  const msg = (fe && fe.message) || "erreur réseau";
  if (code.endsWith("permission-denied")) return new ClaudeError("password", msg);
  if (code.endsWith("resource-exhausted")) return new ClaudeError("quota", msg);
  if (code.endsWith("unavailable") || code.endsWith("deadline-exceeded") || code.endsWith("internal")) {
    return new ClaudeError("unavailable", msg);
  }
  return new ClaudeError("unknown", msg);
}

/** Vérifie le mot de passe côté serveur sans appeler le modèle. */
export async function pingClaude(password: string): Promise<void> {
  const fn = httpsCallable<{ password: string; ping: true }, { ok: boolean }>(functions, "claudeTurn");
  try {
    await fn({ password, ping: true });
  } catch (e) {
    throw toClaudeError(e);
  }
}

/** Un tour du général : l'état visible + le journal → un plan validé. */
export async function askClaudeTurn(
  password: string,
  state: ClaudeState,
  journal: ClaudeJournalEntry[]
): Promise<ClaudeTurnResult> {
  const fn = httpsCallable<{ password: string; state: ClaudeState; journal: ClaudeJournalEntry[] }, ClaudeTurnResult>(
    functions,
    "claudeTurn",
    { timeout: 50000 }
  );
  try {
    const res = await fn({ password, state, journal: journal.slice(-6) });
    const r = res.data;
    if (!r || !r.plan || !Array.isArray(r.plan.ordres)) throw new ClaudeError("unknown", "plan vide");
    return r;
  } catch (e) {
    throw toClaudeError(e);
  }
}
