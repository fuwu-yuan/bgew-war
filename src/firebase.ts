import { initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";

const firebaseConfig = {
  apiKey: "AIzaSyBPMtXSVhT68iJbdnrZKyQ58LPmHJm1E6c",
  authDomain: "bgew-war.firebaseapp.com",
  projectId: "bgew-war",
  storageBucket: "bgew-war.firebasestorage.app",
  messagingSenderId: "302450615368",
  appId: "1:302450615368:web:689c466f32b59664a4247d",
  measurementId: "G-10NGZGV8ZH",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app); // ranked validation (default region)
const DISABLED = new URLSearchParams(window.location.search).get("firebase") === "off";

setPersistence(auth, browserLocalPersistence).catch(() => undefined);

export interface LeaderboardEntry {
  uid: string;
  name: string;
  wins: number;
  losses: number;
  games: number;
  bestTime: number | null;
}

export interface PlayerRank {
  rank: number;
  entry: LeaderboardEntry;
}

/** One recorded multiplayer match, read back from users/<uid>/matches. */
export interface MatchRecord {
  win: boolean;
  time: number;
  share: number;
  kills: number;
  losses: number;
  faction: number;
  createdAt: Date | null;
}

export function currentUser(): User | null {
  return auth.currentUser;
}

export function onUserChange(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, cb);
}

/* ------------------------------------------------------------------ *
 * Auth-ready signal + menu preload. The splash uses these to warm the
 * session, pseudo and leaderboard while it animates, so the menu paints
 * instantly with no loading flash.
 * ------------------------------------------------------------------ */
let authSettled = false;
const authWaiters: Array<() => void> = [];
onAuthStateChanged(auth, () => {
  authSettled = true;
  authWaiters.splice(0).forEach((f) => f());
});

/** Resolves once Firebase has restored (or ruled out) a persisted session. */
export function authReady(): Promise<void> {
  return authSettled ? Promise.resolve() : new Promise((res) => authWaiters.push(res));
}

export interface MenuData {
  name: string | null; // chosen pseudo, or null when not signed in
  leaderboard: LeaderboardEntry[];
  rank: PlayerRank | null;
}

let menuCache: MenuData | null = null;
let menuPromise: Promise<MenuData> | null = null;

/** Fetch (once) everything the menu shows. Resilient: failures yield empty data. */
export function preloadMenuData(): Promise<MenuData> {
  if (menuPromise) return menuPromise;
  menuPromise = (async () => {
    await authReady();
    const user = auth.currentUser;
    const [leaderboard, rank, name] = await Promise.all([
      loadLeaderboard(10).catch(() => [] as LeaderboardEntry[]),
      loadMyRank().catch(() => null),
      user && !user.isAnonymous ? profileName(user).catch(() => displayName(user)) : Promise.resolve(null),
    ]);
    menuCache = { name, leaderboard, rank };
    return menuCache;
  })();
  return menuPromise;
}

/** The last preloaded snapshot, or null until the preload resolves. */
export function cachedMenuData(): MenuData | null {
  return menuCache;
}

export async function signInGoogle(): Promise<User> {
  if (DISABLED) throw new Error("firebase_disabled");
  const cred = await signInWithPopup(auth, new GoogleAuthProvider());
  await ensureUserProfile(cred.user);
  return cred.user;
}

export async function logout(): Promise<void> {
  await signOut(auth);
}

export async function ensureUserProfile(user = auth.currentUser): Promise<void> {
  if (!user || user.isAnonymous) return;
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  await setDoc(ref, {
    name: displayName(user),
    wins: 0,
    losses: 0,
    games: 0,
    bestTime: null,
    needsName: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function needsPseudo(user = auth.currentUser): Promise<boolean> {
  if (DISABLED || !user || user.isAnonymous) return false;
  const snap = await getDoc(doc(db, "users", user.uid));
  return snap.exists() && snap.data().needsName === true;
}

export async function setPseudo(name: string, user = auth.currentUser): Promise<void> {
  if (DISABLED || !user || user.isAnonymous) return;
  const clean = cleanPseudo(name) || displayName(user);
  await updateDoc(doc(db, "users", user.uid), {
    name: clean,
    needsName: false,
    updatedAt: serverTimestamp(),
  });
}

/** The chosen pseudo from the Firestore profile, falling back to the Google name. */
export async function profileName(user = auth.currentUser): Promise<string> {
  if (!user) return "Joueur";
  if (DISABLED || user.isAnonymous) return displayName(user);
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const n = snap.exists() ? snap.data().name : null;
    return typeof n === "string" && n ? n : displayName(user);
  } catch {
    return displayName(user);
  }
}

/**
 * Sign in with Google and, the FIRST time an account is created, prompt for a
 * leaderboard pseudo. Centralised so every entry point (menu, end screen…)
 * behaves the same. Returns the effective display name and whether we asked.
 */
export async function signInGoogleWithPseudo(): Promise<{ user: User; name: string; asked: boolean }> {
  const user = await signInGoogle();
  const asked = await needsPseudo(user);
  if (asked) {
    const chosen = window.prompt("Choisissez votre pseudo pour le classement", displayName(user));
    const name = cleanPseudo(chosen || "") || displayName(user);
    await setPseudo(name, user);
    return { user, name, asked };
  }
  return { user, name: await profileName(user), asked };
}

/** Payload sent to the `submitMatchResult` Cloud Function. */
export interface MatchSubmission {
  matchId: string;
  opponentUid: string;
  win: boolean;
  time: number;
  share: number;
  kills: number;
  losses: number;
  faction: number;
}

/** The function's verdict. `recorded` is true once both players agreed and the
 *  stats were written; `pending` means we're still waiting on the opponent. */
export interface MatchOutcome {
  status: "pending" | "resolved" | "disputed";
  recorded: boolean;
  reason?: string;
}

/**
 * Submit a multiplayer result for ranked validation. Stats are NEVER written
 * by the client: the trusted Cloud Function cross-checks both players' reports
 * (agreement, durations, server-side IP, single-use match token) and only then
 * applies the increments. Safe to call twice for the same match (idempotent) —
 * the end screen polls once on "pending" to catch the opponent's report.
 */
export async function submitMatchResult(s: MatchSubmission): Promise<MatchOutcome> {
  if (DISABLED) return { status: "pending", recorded: false };
  const user = auth.currentUser;
  if (!user || user.isAnonymous) return { status: "disputed", recorded: false, reason: "non_connecte" };
  const fn = httpsCallable<MatchSubmission, MatchOutcome>(functions, "submitMatchResult");
  const res = await fn({ ...s, time: Math.round(s.time) });
  return res.data;
}

export async function loadLeaderboard(n = 10): Promise<LeaderboardEntry[]> {
  if (DISABLED) return [];
  const q = query(collection(db, "users"), orderBy("wins", "desc"), limit(n));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => {
      const x = d.data();
      return {
        uid: d.id,
        name: typeof x.name === "string" ? x.name : "Joueur",
        wins: typeof x.wins === "number" ? x.wins : 0,
        losses: typeof x.losses === "number" ? x.losses : 0,
        games: typeof x.games === "number" ? x.games : 0,
        bestTime: typeof x.bestTime === "number" ? x.bestTime : null,
      };
    })
    .sort((a, b) => b.wins - a.wins || (a.bestTime ?? Infinity) - (b.bestTime ?? Infinity));
}

export async function loadMyRank(): Promise<PlayerRank | null> {
  if (DISABLED) return null;
  const user = auth.currentUser;
  if (!user || user.isAnonymous) return null;
  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists()) return null;
  const x = snap.data();
  const entry: LeaderboardEntry = {
    uid: user.uid,
    name: typeof x.name === "string" ? x.name : displayName(user),
    wins: typeof x.wins === "number" ? x.wins : 0,
    losses: typeof x.losses === "number" ? x.losses : 0,
    games: typeof x.games === "number" ? x.games : 0,
    bestTime: typeof x.bestTime === "number" ? x.bestTime : null,
  };
  const better = await getCountFromServer(query(collection(db, "users"), where("wins", ">", entry.wins)));
  return { rank: better.data().count + 1, entry };
}

/** Read the player's latest multiplayer matches (newest first). */
export async function loadMyMatches(n = 20): Promise<MatchRecord[]> {
  if (DISABLED) return [];
  const user = auth.currentUser;
  if (!user || user.isAnonymous) return [];
  const q = query(collection(db, "users", user.uid, "matches"), orderBy("createdAt", "desc"), limit(n));
  const snap = await getDocs(q);
  return snap.docs.map((d) => {
    const x = d.data();
    const ts = x.createdAt;
    return {
      win: x.win === true,
      time: typeof x.time === "number" ? x.time : 0,
      share: typeof x.share === "number" ? x.share : 0,
      kills: typeof x.kills === "number" ? x.kills : 0,
      losses: typeof x.losses === "number" ? x.losses : 0,
      faction: typeof x.faction === "number" ? x.faction : 0,
      createdAt: ts && typeof ts.toDate === "function" ? ts.toDate() : null,
    };
  });
}

export function displayName(user: User): string {
  return user.displayName || user.email?.split("@")[0] || "Joueur";
}

function cleanPseudo(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 24);
}
