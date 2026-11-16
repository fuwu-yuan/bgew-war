/**
 * Niveau CLAUDE — pont client vers le général (Cloud Function `claudeTurn`).
 *
 * Le général est un STRATÈGE : le commandant local (src/commander.ts) joue
 * seul, en continu. Toutes les ~20 s, le client envoie un rapport de bataille
 * (ce que le joueur voit + ce que le joueur a fait) ; le modèle répond par une
 * DOCTRINE — les réglages du commandant — appliquée aussitôt. Si le général
 * est injoignable, rien ne s'arrête : le commandant garde sa doctrine.
 *
 * Le mot de passe est demandé au menu, vérifié côté serveur (`ping`) puis
 * mémorisé en localStorage. La clé API Anthropic n'existe que dans la
 * fonction : rien de secret dans ce bundle.
 */
import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import type { UpgradeKind, UpLevels } from "./balance";
import type { Genome, Spend } from "./commander";

export interface ClaudeSide {
  barracks: number;
  factories: number;
  turrets: number;
  /** Tourelles hors de la base (à portée du front) : celles qui gênent un hélico. */
  frontTurrets: number;
  soldiers: number;
  tanks: number;
  helis: number;
  ups: Record<UpgradeKind, UpLevels>;
}

/** Le rapport envoyé au général : ce qui est visible à l'écran + les habitudes du joueur. */
export interface ClaudeReport {
  turn: number;
  t: number;
  /** Part de territoire rouge 0..1, et son historique (un point toutes les 10 s). */
  share: number;
  trend: number[];
  gold: number; // or ROUGE (le sien)
  suddenDeathIn: number; // s avant la mort subite (≤ 0 : en cours)
  hq: { red: number; blue: number }; // pv 0..1
  me: ClaudeSide;
  foe: ClaudeSide;
  habits: {
    strikes: number;
    helis: number;
    barracks: number;
    forwardBarracks: number;
    factories: number;
    turrets: number;
    upgrades: Record<string, number>;
    favoredCol: number;
    recent: string[];
  };
  spent: Record<Spend, number>;
  doctrine: Genome;
}

/** Une doctrine passée et ce qu'elle a donné (mémoire courte du général). */
export interface ClaudeJournalEntry {
  t: number;
  analyse: string;
  changes: string;
  shareBefore: number;
  shareAfter: number;
}

/** Réponse du général : la doctrine est partielle/nullable, le client la borne et la fusionne. */
export interface ClaudeAdvice {
  analyse: string;
  message: string;
  doctrine: { w?: Partial<Record<Spend, number | null>> } & Partial<Record<Exclude<keyof Genome, "w">, number | null>>;
}

export interface ClaudeTurnResult {
  advice: ClaudeAdvice;
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

/** Un rapport au général → son conseil (doctrine + réplique). */
export async function askClaudeAdvice(
  password: string,
  report: ClaudeReport,
  journal: ClaudeJournalEntry[]
): Promise<ClaudeTurnResult> {
  const fn = httpsCallable<{ password: string; report: ClaudeReport; journal: ClaudeJournalEntry[] }, ClaudeTurnResult>(
    functions,
    "claudeTurn",
    { timeout: 50000 }
  );
  try {
    const res = await fn({ password, report, journal: journal.slice(-5) });
    const r = res.data;
    if (!r || !r.advice || typeof r.advice.doctrine !== "object") throw new ClaudeError("unknown", "conseil vide");
    return r;
  } catch (e) {
    throw toClaudeError(e);
  }
}
