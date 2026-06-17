import { Board, Network } from "@fuwu-yuan/bgew";

/**
 * Server override: by default the game talks to the official BGEW server
 * (bgew.stevecohen.fr). Add `?server=host:port` to the URL to use a
 * self-hosted `tools/server.mjs` instead (same protocol) — handy while the
 * official server is down, for LAN/tunnel play or for the headless tests.
 * `?server=` (empty) or `?server=same` means "the host serving this page"
 * — tools/server.mjs also serves the game, so one tunnel covers all.
 * The override is REMEMBERED (localStorage): open the game once with the
 * full link and the bare URL keeps working afterwards. `?server=off`
 * forgets it and returns to the official server.
 * Protocols follow the page (https page → https API + wss socket).
 */
const STORAGE_KEY = "bgew-war.server";
const RAW = new URLSearchParams(window.location.search).get("server");
const fromParam = RAW === "" || RAW === "same" ? window.location.host : RAW;
let OVERRIDE: string | null = null;
try {
  if (fromParam === "off") {
    localStorage.removeItem(STORAGE_KEY);
  } else if (fromParam) {
    localStorage.setItem(STORAGE_KEY, fromParam);
    OVERRIDE = fromParam;
  } else {
    OVERRIDE = localStorage.getItem(STORAGE_KEY);
  }
} catch {
  OVERRIDE = fromParam === "off" ? null : fromParam;
}
const SECURE = window.location.protocol === "https:";

/**
 * Extract the game payload from a broadcast SocketMessage.
 * The official server relays the WHOLE client packet ({id, msg}) in
 * `data`, so the payload lives in `data.msg`; tools/server.mjs and other
 * implementations may unwrap it into `data` directly. Accept both.
 */
export function gameData(msg: Network.SocketMessage): (GameMsg & { type: string }) | null {
  const d = msg?.data;
  if (!d || typeof d !== "object") return null;
  if (typeof d.type === "string") return d as GameMsg & { type: string };
  if (d.msg && typeof d.msg === "object" && typeof d.msg.type === "string") {
    return d.msg as GameMsg & { type: string };
  }
  return null;
}

export class WarNetworkManager extends Network.NetworkManager {
  /**
   * Engine quirk: NetworkManager.joinRoom only stores the room uid when it
   * is still empty, so joining a second room in the same session leaves
   * every REST call (room data, close…) pointed at the FIRST room.
   */
  joinRoom(uid: string): Promise<Network.Response> {
    this.roomuid = uid;
    return super.joinRoom(uid);
  }

  get apiUrl(): string {
    return OVERRIDE ? `${SECURE ? "https" : "http"}://${OVERRIDE}/api` : "https://bgew.stevecohen.fr/api";
  }

  get wsUrl(): string {
    return OVERRIDE ? `${SECURE ? "wss" : "ws"}://${OVERRIDE}/` : "wss://bgew.stevecohen.fr/";
  }
}

export function installNetwork(board: Board): void {
  const nm = new WarNetworkManager(board);
  board.networkManager = nm;

  // Application-level keepalive: the BGEW protocol is silent while players
  // wait in a salon, and proxies (Cloudflare tunnels…) kill idle websockets
  // in ~90 s. The server acks "ka" without relaying it to the other player.
  setInterval(() => {
    const subject = (nm as unknown as { webSocketSubject: { closed?: boolean } | null }).webSocketSubject;
    if (!subject || subject.closed) return;
    try {
      nm.sendMessage({ type: "ka" }).catch(() => undefined);
    } catch {
      /* socket already gone */
    }
  }, 20_000);
}

/* ------------------------------------------------------------------ *
 * Game protocol (inside SocketMessage.data)
 * ------------------------------------------------------------------ */

/** Lobby: creator → joiner when the room is complete. `creatorHosts` carries
 *  the random host draw so both sides agree on who runs the simulation. */
export interface StartMsg {
  type: "start";
  creatorHosts?: boolean;
}

/** Guest → host: "I'm in the game step, send me the island" (retried) */
export interface ReadyMsg {
  type: "ready";
  /** Guest's display name, piggybacked so the host can label the enemy. */
  name?: string;
  /** Guest's Firebase uid (empty when not signed in) — for ranked validation. */
  uid?: string;
}

/** Host → guest, once: the generated island */
export interface InitMsg {
  type: "init";
  map: { terrain: number[]; owner: number[]; decors: number[][]; chests: number[] };
  /** Host's display name, piggybacked so the guest can label the enemy. */
  name?: string;
  /** Host's Firebase uid (empty when not signed in) — for ranked validation. */
  uid?: string;
  /** Shared match id (host-generated) the Cloud Function correlates on. */
  matchId?: string;
  /** Shared RNG seed (host-generated) so both clients' sims draw the same
   *  random sequence — foundation for the lockstep branch. */
  seed?: number;
}

/** Host → guest, ~10 Hz */
export interface SnapMsg {
  type: "snap";
  /** DYNAMIC per-unit state, every snapshot: [nid, x, y]. `hp` is omitted for
   *  full-health units (the majority) and carried in `hurt` instead. Static
   *  fields (kind/faction/maxHp/level) are sent ONCE in `spawns`. */
  units: number[][];
  /** [nid, hp] only for units below full health since last snap. The guest
   *  treats any live unit not listed here as full-health. */
  hurt?: number[][];
  /** Units first seen since the last snapshot: [nid, kind, faction, maxHp, level].
   *  Sent once per unit (WebSocket/TCP is reliable + ordered, so it can't be lost). */
  spawns: number[][];
  /** [nid, typeCode, faction, col, row, hp, maxHp, buildPct(0-100)] */
  buildings: number[][];
  /** [tileIndex, owner] since last snap */
  own: number[][];
  /** [x, y, tx, ty, big] tracers fired since last snap */
  shots: number[][];
  /** [x, y, big] explosions since last snap */
  booms: number[][];
  /** [x, y] airstrike warnings since last snap */
  warns: number[][];
  /** [x, y, text, colorIdx] popups since last snap (colorIdx: 0 gold, 1 red) */
  pops: [number, number, string, number][];
  gold: { red: number; blue: number };
  lvl: { red: number; blue: number; tankRed?: number; tankBlue?: number; turretRed?: number; turretBlue?: number };
  share: number; // blue share 0..1
  /** Host's cumulative meaningful-action count — the guest uses it to tell
   *  whether the host is actually playing (anti-AFK). */
  acts?: number;
  /** The host's current snapshot interval (s). The guest interpolates over
   *  exactly this, so motion stays smooth at any (adaptive) send rate. */
  period?: number;
}

/** Host → guest: the war is over */
export interface EndMsg {
  type: "end";
  winner: number; // Faction
  time: number;
  share: number; // blue share
  kills: { red: number; blue: number };
}

/** Guest → host: an order for the red side */
export interface CmdMsg {
  type: "cmd";
  cmd: "build" | "axis" | "upgrade" | "strike" | "helico";
  kind?: "barracks" | "turret" | "factory" | "soldier" | "tank";
  c?: number;
  r?: number;
  col?: number;
  x?: number;
  y?: number;
}

/** Either side → the other: a salted hash of the player's public IP, so each
 *  client can tell if both players sit behind the same address (unranked). */
export interface IpMsg {
  type: "ip";
  hash: string;
}

/** Either side → the other: the match is cancelled and must NOT be ranked
 *  (e.g. an inactive opponent). Both clients drop to a neutral end screen. */
export interface VoidMsg {
  type: "void";
  reason: string;
}

export type GameMsg = StartMsg | ReadyMsg | InitMsg | SnapMsg | EndMsg | CmdMsg | IpMsg | VoidMsg;

/** Role passed to the game step via moveToStep data */
export interface MultiData {
  role: "host" | "guest";
}

/* ------------------------------------------------------------------ *
 * Matchmaking / private rooms — encoded in the relay room NAME so no
 * extra backend is needed. Quick-match rooms carry the creator's win
 * count (for level grouping); private rooms carry a short join code.
 * ------------------------------------------------------------------ */

/** `MM|<wins>|<nonce>` — a quick-match room advertising the host's level. */
export function mmRoomName(wins: number): string {
  const w = Math.max(0, Math.min(99999, Math.floor(wins || 0)));
  return `MM|${w}|${Math.random().toString(36).slice(2, 8)}`;
}

/** True for a quick-match room. */
export function isMatchmakingRoom(name: string): boolean {
  return !!name && name.startsWith("MM|");
}

/** The advertised win count of a quick-match room (0 if unparseable). */
export function mmWins(name: string): number {
  const w = parseInt((name || "").split("|")[1], 10);
  return Number.isFinite(w) ? w : 0;
}

// Unambiguous alphabet (no O/0/I/1) for human-readable join codes.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A fresh 4-character private-room code. */
export function genJoinCode(): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

/** `PV|<CODE>` — a private room joinable by code or shared link. */
export function pvRoomName(code: string): string {
  return `PV|${code.toUpperCase()}`;
}

/** The join code of a private room, or null. */
export function pvCode(name: string): string | null {
  if (!name || !name.startsWith("PV|")) return null;
  return name.split("|")[1] || null;
}

/**
 * Read (and clear) a `?join=CODE` deep-link param. Cleared from the URL so a
 * refresh or back-navigation doesn't try to re-join a finished game.
 */
export function consumeJoinCode(): string | null {
  const c = new URLSearchParams(window.location.search).get("join");
  if (!c) return null;
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete("join");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
  } catch {
    /* history API unavailable — harmless */
  }
  return /^[A-Za-z0-9]{4}$/.test(c) ? c.toUpperCase() : null;
}
