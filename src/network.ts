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

export class WarNetworkManager extends Network.NetworkManager {
  get apiUrl(): string {
    return OVERRIDE ? `${SECURE ? "https" : "http"}://${OVERRIDE}/api` : "https://bgew.stevecohen.fr/api";
  }

  get wsUrl(): string {
    return OVERRIDE ? `${SECURE ? "wss" : "ws"}://${OVERRIDE}/` : "wss://bgew.stevecohen.fr/";
  }
}

export function installNetwork(board: Board): void {
  board.networkManager = new WarNetworkManager(board);
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
}

/** Host → guest, once: the generated island */
export interface InitMsg {
  type: "init";
  map: { terrain: number[]; owner: number[]; decors: number[][]; chests: number[] };
}

/** Host → guest, ~10 Hz */
export interface SnapMsg {
  type: "snap";
  /** [nid, kind(0 soldier/1 tank), faction, x, y, hp, maxHp, level] */
  units: number[][];
  /** [nid, typeCode, faction, col, row, hp, maxHp] */
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
  lvl: { red: number; blue: number };
  share: number; // blue share 0..1
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
  cmd: "build" | "axis" | "upgrade" | "strike";
  kind?: "barracks" | "turret" | "factory";
  c?: number;
  r?: number;
  col?: number;
  x?: number;
  y?: number;
}

export type GameMsg = StartMsg | ReadyMsg | InitMsg | SnapMsg | EndMsg | CmdMsg;

/** Role passed to the game step via moveToStep data */
export interface MultiData {
  role: "host" | "guest";
}
