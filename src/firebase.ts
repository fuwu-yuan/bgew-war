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
  addDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  getFirestore,
  increment,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

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

export interface MultiMatchStats {
  win: boolean;
  time: number;
  share: number;
  kills: number;
  losses: number;
  faction: number;
}

export interface PlayerRank {
  rank: number;
  entry: LeaderboardEntry;
}

export function currentUser(): User | null {
  return auth.currentUser;
}

export function onUserChange(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, cb);
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

export async function recordMultiResult(stats: MultiMatchStats): Promise<void> {
  if (DISABLED) return;
  const user = auth.currentUser;
  if (!user || user.isAnonymous) return;
  const ref = doc(db, "users", user.uid);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists() ? snap.data() : {};
    const best = typeof prev.bestTime === "number" ? prev.bestTime : null;
    tx.set(
      ref,
      {
        wins: increment(stats.win ? 1 : 0),
        losses: increment(stats.win ? 0 : 1),
        games: increment(1),
        bestTime: stats.win ? (best === null ? Math.round(stats.time) : Math.min(best, Math.round(stats.time))) : best,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  });
  await addDoc(collection(db, "users", user.uid, "matches"), {
    win: stats.win,
    time: Math.round(stats.time),
    share: Math.round(stats.share * 1000) / 1000,
    kills: stats.kills,
    losses: stats.losses,
    faction: stats.faction,
    createdAt: serverTimestamp(),
  });
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

export function displayName(user: User): string {
  return user.displayName || user.email?.split("@")[0] || "Joueur";
}

function cleanPseudo(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 24);
}
