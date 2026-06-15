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

/** Shown in the lobby so players know which backend they are on. */
export function serverLabel(): string {
  return OVERRIDE ?? "bgew.stevecohen.fr (officiel)";
}

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

/** Lobby: host → guest when the room is complete */
export interface StartMsg {
  type: "start";
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
}

/** Host → guest, ~10 Hz */
export interface SnapMsg {
  type: "snap";
  /** [nid, kind(0 soldier/1 tank/2 helico), faction, x, y, hp, maxHp, level] */
  units: number[][];
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
