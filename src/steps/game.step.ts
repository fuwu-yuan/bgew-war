import { Board, Entity, GameStep, Network } from "@fuwu-yuan/bgew";
import { GameAPI, Target } from "../api";
import {
  BLUE,
  COLORS,
  COST,
  Faction,
  GRID_H,
  GRID_W,
  MAP_H,
  MAX_HELIS,
  MAX_SOLDIERS,
  MAX_TANKS,
  RED,
  STRIKE_DELAY,
  STRIKE_DMG_BUILDING,
  STRIKE_DMG_UNIT,
  STRIKE_RADIUS,
  TILE,
  VIEW_W,
  enemyOf,
  soldierUpgradeCost,
  tankUpgradeCost,
  turretUpgradeCost,
} from "../globals";
import { clamp, pick, rand, randInt, sha256, TAU } from "../utils";
import { seedSim, srand } from "../sim-rng";
import { flipMapData, flipTileIndex, TileMap } from "../entities/tilemap";
import { Bullet, Soldier, Tank, Unit } from "../entities/units";
import { Building, BUILDING_CODE, BuildingType } from "../entities/buildings";
import { Helicopter } from "../entities/helicopter";
import { Fader, FpsMeter, Particle, ScorePopup, Shockwave, StrikeMarker, Tracer } from "../entities/effects";
import { BuildMode, Hud, HudState } from "../entities/hud";
import { GameObject } from "../entities/gameobject";
import { RemoteWorld } from "../entities/remote";
import { CmdMsg, EndMsg, GameMsg, gameData, InitMsg, IpMsg, MultiData, SnapMsg, VoidMsg } from "../network";
import { track, trackScreen } from "../analytics";
import { toggleMute } from "../sound";
import { currentUser, displayName } from "../firebase";

const BRAIN_EVERY = 3; // s — red AI thinks (solo only)
const INCOME_EVERY = 1; // s
const SNAP_EVERY = 0.1; // s — host → guest snapshots
/* Anti-cheat (ranked multiplayer fairness) */
const IDLE_LIMIT = 30; // s of opponent inactivity → the match is stopped & voided
const MIN_RANKED_DURATION = 20; // s — anything shorter can't be ranked
const MAX_EFFECTS = 320; // hard cap on live cosmetic entities (particles, tracers…)

/** A unique, shared id for one match (host-minted, sent to the guest). */
function newMatchId(): string {
  const c = window.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
const AI_GRACE = 6; // s before the AI starts spending
const GARRISON_COST = 50;
const GARRISON_CD = 8; // s
const HQ_ALERT_RADIUS = 240; // px — enemies this close to the HQ trigger panic
const AI_MIN_RESERVE = GARRISON_COST + 20;
const AI_REPLAN_VARIANCE = 0.35;
const HQ_DEFENSE_RADIUS = 340;
const HQ_DEFENSE_MIN_SOLDIERS = 36;
const HQ_DEFENSE_MAX_SOLDIERS = 130;
const HQ_DEFENSE_MIN_TANKS = 4;
const HQ_DEFENSE_MAX_TANKS = 16;

type NetRole = "solo" | "host" | "guest";
type AiPosture = "defend" | "counter" | "press" | "tech";
type UpgradeKind = "soldier" | "tank" | "turret";

interface RedAiIntel {
  posture: AiPosture;
  axis: number;
  pressureCol: number;
  opportunityCol: number;
  blueTanks: number;
  blueSoldiers: number;
  blueTurrets: number;
  blueFactories: number;
  blueBarracks: number;
  blueHelis: number;
  redSoldiers: number;
  redTurrets: number;
  redFactories: number;
  redBarracks: number;
  redShare: number;
  deepestBlueRow: number;
  infantryFlood: boolean;
}

export class PlayStep extends GameStep implements GameAPI, HudState {
  name = "game";

  public map!: TileMap;
  private hud!: Hud;
  private remote: RemoteWorld | null = null;
  private units: Unit[] = [];
  private bullets: Bullet[] = [];
  private buildings: Building[] = [];
  private helis: Helicopter[] = [];
  private heliLoopOn = false;
  private effects: GameObject[] = [];
  private buildingAt = new Map<number, Building>();
  private topEntities: Entity[] = [];

  /* Multiplayer */
  private role: NetRole = "solo";
  public myFaction: Faction = BLUE;
  private inited = true; // guest: received init from host
  private readyT = 0;
  private snapT = 0;
  private sentStatic = new Set<number>(); // host: unit nids whose static data the guest already has
  private fpsMeter: FpsMeter | null = null; // ?debug=1 diagnostic overlay
  private debug = false;
  private lastSnapBytes = 0; // approx wire size of the last received snapshot (debug)

  /* Anti-cheat: opponent-activity tracking + same-IP detection */
  private oppActed = false; // opponent issued at least one real order
  private myActs = 0; // my meaningful actions (host streams this in snapshots)
  private lastSeenActs = 0; // guest: last host action count seen in a snapshot
  private myIpHash: string | null = null;
  private oppIpHash: string | null = null;
  private sameIp = false;
  private voided = false; // match cancelled → unranked, neutral end
  private voidReason = "";
  /* Ranked validation: a shared match id + both uids, sent to the Cloud Function */
  private matchId = "";
  private myUid = "";
  private enemyUid = "";
  /* Lockstep foundation: shared RNG seed (host-minted, sent in init). */
  private matchSeed = 0;
  private nextNid = 1;
  private pShots: number[][] = [];
  private pBooms: number[][] = [];
  private pPops: [number, number, string, number][] = [];
  private pWarns: number[][] = [];

  /* Airstrikes in flight + solo-AI panic state */
  private strikes: { x: number; y: number; t: number; faction: Faction }[] = [];
  private garrisonCd = 0;
  private alertT = 0;
  private hqLastHp: Record<Faction, number> = { [RED]: 0, [BLUE]: 0 };
  private hqDefenseUsed: Record<Faction, boolean> = { [RED]: false, [BLUE]: false };

  /* HudState */
  public mode: BuildMode = null;
  public elapsed = 0;
  public blueShare = 0.5;
  public axisMarker: { x: number; y: number } | null = null;
  public myName = "Vous";
  public enemyName = "Adversaire";

  private gold: Record<Faction, number> = { [RED]: 0, [BLUE]: 0 };
  private levels: Record<Faction, number> = { [RED]: 1, [BLUE]: 1 };
  private tankLevels: Record<Faction, number> = { [RED]: 1, [BLUE]: 1 };
  private turretLevels: Record<Faction, number> = { [RED]: 1, [BLUE]: 1 };
  private killsBy: Record<Faction, number> = { [RED]: 0, [BLUE]: 0 };
  private axisCol: Record<Faction, number> = { [RED]: 8, [BLUE]: 8 };
  private counts = {
    [RED]: { soldiers: 0, tanks: 0 },
    [BLUE]: { soldiers: 0, tanks: 0 },
  };
  private ended = false;
  private brainT = BRAIN_EVERY;
  private aiPosture: AiPosture = "counter";
  private incomeT = INCOME_EVERY;
  private buckets: Target[][] = [];
  private sfxLast = new Map<string, number>();

  get myGold(): number {
    return this.gold[this.myFaction];
  }

  /** Flip-invariant gameplay signature for desync detection (host vs guest). */
  simSignature(): { t: number; units: number; buildings: number; goldR: number; goldB: number; share: number } {
    const units = this.role === "guest" ? this.remote?.unitCount ?? 0 : this.units.filter((u) => !u.dead).length;
    const buildings = this.role === "guest" ? this.remote?.buildingCount ?? 0 : this.buildings.filter((b) => !b.dead).length;
    return {
      t: Math.round(this.elapsed),
      units,
      buildings,
      goldR: Math.floor(this.gold[RED]),
      goldB: Math.floor(this.gold[BLUE]),
      share: Math.round(this.blueShare * 100),
    };
  }

  get soldierLevel(): number {
    return this.levels[this.myFaction];
  }

  get soldierUpgradeCost(): number {
    return soldierUpgradeCost(this.levels[this.myFaction]);
  }

  get tankLevel(): number {
    return this.tankLevels[this.myFaction];
  }

  get tankUpgradeCost(): number {
    return tankUpgradeCost(this.tankLevels[this.myFaction]);
  }

  get turretLevel(): number {
    return this.turretLevels[this.myFaction];
  }

  get turretUpgradeCost(): number {
    return turretUpgradeCost(this.turretLevels[this.myFaction]);
  }

  constructor(board: Board) {
    super(board);
    board.onMouseEvent("click", (_e: MouseEvent, x: number, y: number) => {
      if (board.step !== this || this.ended) return;
      this.handleTap(x, y);
    });
    board.onKeyboardEvent("keydown", (e: KeyboardEvent) => {
      if (board.step !== this || this.ended) return;
      this.handleKey(e);
    });
  }

  /** Keyboard shortcuts for the command HUD (desktop). Mirrors a button tap. */
  private handleKey(e: KeyboardEvent): void {
    if (!this.hud || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
      if (this.mode) {
        this.mode = null;
        this.board.playSound("click", false, 0.3);
      }
      return;
    }
    if (e.key.toLowerCase() === "m") {
      this.toggleSound();
      return;
    }
    const id = this.hud.buttonForKey(e.key);
    if (!id) return;
    if (id === "upgradeSoldier" || id === "upgradeTank" || id === "upgradeTurret") {
      this.requestUpgrade(id === "upgradeTank" ? "tank" : id === "upgradeTurret" ? "turret" : "soldier");
      return;
    }
    this.board.playSound("click", false, 0.4);
    this.mode = this.mode === id ? null : (id as BuildMode);
  }

  private toggleSound(): void {
    const muted = toggleMute();
    if (!muted) this.board.playSound("click", false, 0.4); // audible only when turning sound back on
    track("toggle_mute", { muted });
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  onEnter(data: { multi?: MultiData }): void {
    this.role = data?.multi ? (data.multi.role === "guest" ? "guest" : "host") : "solo";
    this.myFaction = this.role === "guest" ? RED : BLUE;

    // Player names shown in the HUD. Local name = signed-in pseudo, else a
    // sensible default. The enemy name arrives over the network (ready/init)
    // so it starts as a placeholder.
    const u = currentUser();
    this.myName = u && !u.isAnonymous ? displayName(u) : this.role === "solo" ? "Vous" : "Invite";
    this.enemyName = this.role === "solo" ? "IA" : this.role === "guest" ? "Adversaire" : "Invite";
    // Ranked identity: my uid (empty when not signed in) and a shared match id
    // the host mints and shares so the Cloud Function can pair the two reports.
    this.myUid = u && !u.isAnonymous ? u.uid : "";
    this.enemyUid = "";
    this.matchId = this.role === "host" ? newMatchId() : "";
    this.matchSeed = this.role === "host" ? (Math.floor(Math.random() * 0xffffffff) >>> 0) : 0;
    // Seed the sim RNG now for the host/solo (which run the sim). The guest
    // reseeds when it receives the host's seed in `init`.
    if (this.role !== "guest") seedSim(this.role === "solo" ? (Math.floor(Math.random() * 0xffffffff) >>> 0) : this.matchSeed);

    trackScreen("game");
    track("game_start", { mode: this.role, faction: this.myFaction === RED ? "red" : "blue" });

    this.units = [];
    this.bullets = [];
    this.buildings = [];
    this.helis = [];
    this.heliLoopOn = false;
    this.effects = [];
    this.buildingAt.clear();
    this.remote = null;
    this.gold = { [RED]: this.role === "solo" ? 40 : 80, [BLUE]: 80 };
    this.levels = { [RED]: 1, [BLUE]: 1 };
    this.tankLevels = { [RED]: 1, [BLUE]: 1 };
    this.turretLevels = { [RED]: 1, [BLUE]: 1 };
    this.killsBy = { [RED]: 0, [BLUE]: 0 };
    this.mode = null;
    this.elapsed = 0;
    this.blueShare = 0.5;
    this.axisMarker = null;
    this.axisCol = { [RED]: 8, [BLUE]: 8 };
    this.counts = { [RED]: { soldiers: 0, tanks: 0 }, [BLUE]: { soldiers: 0, tanks: 0 } };
    this.ended = false;
    this.brainT = BRAIN_EVERY;
    this.aiPosture = "counter";
    this.incomeT = INCOME_EVERY;
    this.snapT = 0;
    this.readyT = 0;
    this.nextNid = 1;
    this.pShots = [];
    this.pBooms = [];
    this.pPops = [];
    this.pWarns = [];
    this.strikes = [];
    this.garrisonCd = 0;
    this.alertT = 0;
    this.hqLastHp = { [RED]: 0, [BLUE]: 0 };
    this.hqDefenseUsed = { [RED]: false, [BLUE]: false };
    this.inited = this.role !== "guest";
    this.sfxLast.clear();
    this.sentStatic.clear();
    this.oppActed = false;
    this.myActs = 0;
    this.lastSeenActs = 0;
    this.myIpHash = null;
    this.oppIpHash = null;
    this.sameIp = false;
    this.voided = false;
    this.voidReason = "";
    this.camera.x = 0;
    this.camera.y = 0;
    if (this.role !== "solo") this.exchangeIpHash();

    this.map = new TileMap();
    this.board.addEntity(this.map);

    if (this.role === "guest") {
      // Passive mirror: the island and every unit come from the host
      this.remote = new RemoteWorld();
      this.board.addEntity(this.remote);
      this.sendNet({ type: "ready", name: this.myName, uid: this.myUid });
    } else {
      // Symmetric starting bases (HQ + 3 barracks + 2 turrets each)
      this.placeBuilding(RED, "hq", 8, 2, true);
      this.placeBuilding(RED, "barracks", 4, 4, true);
      this.placeBuilding(RED, "barracks", 8, 4, true);
      this.placeBuilding(RED, "barracks", 12, 4, true);
      this.placeBuilding(RED, "turret", 6, 3, true);
      this.placeBuilding(RED, "turret", 10, 3, true);

      this.placeBuilding(BLUE, "hq", 8, GRID_H - 3, true);
      this.placeBuilding(BLUE, "barracks", 4, GRID_H - 5, true);
      this.placeBuilding(BLUE, "barracks", 8, GRID_H - 5, true);
      this.placeBuilding(BLUE, "barracks", 12, GRID_H - 5, true);
      this.placeBuilding(BLUE, "turret", 6, GRID_H - 4, true);
      this.placeBuilding(BLUE, "turret", 10, GRID_H - 4, true);

      // First squads so the front moves right away
      for (let i = 0; i < 10; i++) {
        this.spawnSoldier(RED, srand(60, VIEW_W - 60), this.mirrorY(srand(5, 7) * TILE));
        this.spawnSoldier(BLUE, srand(60, VIEW_W - 60), this.mirrorY(srand(GRID_H - 7, GRID_H - 5) * TILE));
      }
      // Initial claims are already part of the init payload the guest gets
      this.map.flushDirty();
    }

    this.hud = new Hud(this);
    this.board.addEntity(this.hud);
    this.topEntities = [this.hud];

    // ?debug=1 → on-screen FPS meter (to tell a CPU stall from snapshot jitter).
    this.fpsMeter = null;
    this.debug = new URLSearchParams(window.location.search).get("debug") === "1";
    this.lastSnapBytes = 0;
    if (this.debug) {
      this.fpsMeter = new FpsMeter();
      this.board.addEntity(this.fpsMeter);
      this.topEntities.push(this.fpsMeter);
    }

    const fadeIn = new Fader(1, 0, 500);
    this.board.addEntity(fadeIn);
    this.topEntities.push(fadeIn);

    this.board.playSound("music_battle", true, 0.3);
  }

  onLeave(): void {
    this.board.stopSound("music_battle", true, 600);
    this.updateHeliLoop(false);
  }

  /* ---------------------------------------------------------------- *
   * Network (multiplayer)
   * ---------------------------------------------------------------- */

  private sendNet(data: GameMsg): void {
    if (this.role === "solo") return;
    this.board.networkManager.sendMessage(data).catch(() => {
      /* connection gone: handled by onConnectionClosed */
    });
  }

  /* ------------------------------------------------------------------
   * Guest view mirror: the red player sees the island flipped vertically
   * so THEIR army sits at the bottom of the screen. Everything coming
   * from the host is converted to view space here, and every command
   * sent back is converted to host space. No-ops for solo/host.
   * ------------------------------------------------------------------ */

  private get flipped(): boolean {
    return this.role === "guest";
  }

  private viewY(y: number): number {
    return this.flipped ? MAP_H - y : y;
  }

  private viewRow(r: number): number {
    return this.flipped ? GRID_H - 1 - r : r;
  }

  private viewIdx(i: number): number {
    return this.flipped ? flipTileIndex(i) : i;
  }

  onNetworkMessage(msg: Network.SocketMessage): void {
    const data = gameData(msg);
    if (!data || this.role === "solo") return;

    // Anti-cheat signals handled the same way for both roles
    if (data.type === "ip") {
      this.onOpponentIp((data as IpMsg).hash);
      return;
    }
    if (data.type === "void") {
      this.voidMatch((data as VoidMsg).reason || "Partie annulee", false);
      return;
    }

    if (this.role === "host") {
      if (data.type === "ready") {
        if (typeof data.name === "string") this.enemyName = data.name || "Invite";
        if (typeof data.uid === "string") this.enemyUid = data.uid;
        // (Re)send the island + an immediate snapshot, carrying our name, uid
        // and the shared match id the guest reports under.
        const init: InitMsg = { type: "init", map: this.map.getInitData(), name: this.myName, uid: this.myUid, matchId: this.matchId, seed: this.matchSeed };
        this.sendNet(init);
        // The (re)joined guest knows no units yet → resend every unit's static data.
        this.sentStatic.clear();
        this.sendSnapshot();
        this.sendNet({ type: "ip", hash: this.myIpHash ?? "" }); // (re)share our IP hash
      } else if (data.type === "cmd") {
        // The guest issued an order → it has played at least once.
        this.oppActed = true;
        this.applyCommand(data as CmdMsg);
      }
      return;
    }

    // Guest
    if (data.type === "init") {
      const initMsg = data as InitMsg;
      if (typeof initMsg.name === "string") this.enemyName = initMsg.name || "Invite";
      if (typeof initMsg.uid === "string") this.enemyUid = initMsg.uid;
      if (typeof initMsg.matchId === "string") this.matchId = initMsg.matchId;
      if (typeof initMsg.seed === "number") {
        this.matchSeed = initMsg.seed;
        seedSim(this.matchSeed); // align the guest's sim RNG with the host
      }
      const init = initMsg.map;
      this.map.applyInit(this.flipped ? flipMapData(init) : init);
      this.inited = true;
      this.sendNet({ type: "ip", hash: this.myIpHash ?? "" }); // share our IP hash
    } else if (data.type === "snap") {
      this.applySnapshot(data as SnapMsg);
    } else if (data.type === "end") {
      const end = data as EndMsg;
      this.killsBy = { [RED]: end.kills.red, [BLUE]: end.kills.blue };
      this.showEnd(end.winner as Faction, end.time, end.share);
    }
  }

  onPlayerLeave(): void {
    this.opponentGone("L'adversaire a quitte la partie");
  }

  // Arrow property: the engine passes this handler UNBOUND to rxjs as the
  // websocket complete-callback (see lobby.step.ts).
  onConnectionClosed = (): void => {
    if (this.board.step !== this) return;
    this.opponentGone("Connexion perdue");
  };

  /* ---------------------------------------------------------------- *
   * Anti-cheat (ranked fairness)
   * ---------------------------------------------------------------- */

  /** Fetch our public IP, hash it, and send the hash to the opponent. The
   *  hash (never the raw IP) lets each side detect two players on one address
   *  without leaking anything. Best-effort: any failure simply skips the check. */
  private exchangeIpHash(): void {
    // Needs the network anyway; off in tests / privacy mode (?firebase=off).
    if (new URLSearchParams(window.location.search).get("firebase") === "off") return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 4000);
    fetch("https://api.ipify.org?format=json", { signal: ctrl.signal })
      .then((r) => r.json())
      .then(async (j: { ip?: string }) => {
        window.clearTimeout(timer);
        if (!j.ip || this.role === "solo" || this.board.step !== this) return;
        this.myIpHash = await sha256(`bgew-war:${j.ip}`);
        this.sendNet({ type: "ip", hash: this.myIpHash });
        // We may already hold the opponent's hash from before ours was ready.
        if (this.oppIpHash) this.compareIp();
      })
      .catch(() => window.clearTimeout(timer));
  }

  private onOpponentIp(hash: string): void {
    if (hash) this.oppIpHash = hash;
    this.compareIp();
  }

  private compareIp(): void {
    if (this.myIpHash && this.oppIpHash && this.myIpHash === this.oppIpHash) this.sameIp = true;
  }

  /** Cancel the match: unranked, neutral end on both sides. */
  private voidMatch(reason: string, notify: boolean): void {
    if (this.ended || this.voided) return;
    this.voided = true;
    this.voidReason = reason;
    if (notify && this.role !== "solo") this.sendNet({ type: "void", reason });
    this.spawnEffect(new ScorePopup(VIEW_W / 2, MAP_H / 2, "PARTIE ANNULEE", "#ffe27a", 18));
    // Reuse the end pipeline; the winner is irrelevant for a void.
    this.showEnd(this.myFaction, this.elapsed, this.blueShare);
  }

  private opponentGone(reason: string): void {
    if (this.role === "solo" || this.ended) return;
    track("opponent_left", { mode: this.role, elapsed: Math.round(this.elapsed) });
    this.spawnEffect(new ScorePopup(VIEW_W / 2, MAP_H / 2, reason.toUpperCase(), "#ffe27a", 18));
    if (this.role === "host") {
      this.endGame(this.myFaction);
    } else {
      this.showEnd(this.myFaction, this.elapsed, this.blueShare);
    }
  }

  /** Host: a validated order from the red (guest) player. */
  private applyCommand(cmd: CmdMsg): void {
    if (this.ended) return;
    if (cmd.cmd === "axis" && typeof cmd.col === "number") {
      this.axisCol[RED] = clamp(Math.round(cmd.col), 0, GRID_W - 1);
      return;
    }
    if (cmd.cmd === "upgrade") {
      this.buyUpgrade(RED, (cmd.kind === "tank" || cmd.kind === "turret" ? cmd.kind : "soldier") as UpgradeKind);
      return;
    }
    if (cmd.cmd === "strike" && typeof cmd.x === "number" && typeof cmd.y === "number") {
      if (this.gold[RED] >= COST.strike) {
        this.gold[RED] -= COST.strike;
        this.scheduleStrike(clamp(cmd.x, 0, VIEW_W), clamp(cmd.y, 0, MAP_H), RED);
      }
      return;
    }
    if (cmd.cmd === "helico" && typeof cmd.x === "number") {
      if (this.gold[RED] >= COST.helico) {
        this.gold[RED] -= COST.helico;
        this.spawnHeli(RED, clamp(cmd.x, 0, VIEW_W));
      }
      return;
    }
    if (
      cmd.cmd === "build" &&
      (cmd.kind === "barracks" || cmd.kind === "turret" || cmd.kind === "factory") &&
      typeof cmd.c === "number" &&
      typeof cmd.r === "number"
    ) {
      const cost = COST[cmd.kind];
      const i = this.map.idx(cmd.c, cmd.r);
      if (
        this.gold[RED] >= cost &&
        this.map.isLand(cmd.c, cmd.r) &&
        this.map.owner[i] === RED &&
        !this.buildingAt.has(i) &&
        !this.map.hasChest(i)
      ) {
        this.gold[RED] -= cost;
        this.placeBuilding(RED, cmd.kind, cmd.c, cmd.r);
        const center = this.map.tileCenter(cmd.c, cmd.r);
        this.spawnEffect(new Shockwave(center.x, center.y, 50, "#ffffff", 0.35));
        this.sfx("build", 0.5);
      }
    }
  }

  /** Host: world state → guest, ~10 Hz. */
  private sendSnapshot(period: number = SNAP_EVERY): void {
    // Split each unit into DYNAMIC state (sent every snapshot) and STATIC data
    // (sent once, the first time the guest sees it). This roughly halves the
    // per-snapshot payload — the guest's main cost.
    const dyn: number[][] = [];
    const spawns: number[][] = [];
    const hurt: number[][] = [];
    const live = new Set<number>();
    const add = (nid: number, kind: number, faction: number, x: number, y: number, hp: number, maxHp: number, level: number): void => {
      live.add(nid);
      dyn.push([nid, x, y]);
      if (hp < maxHp) hurt.push([nid, hp]); // full-health units cost nothing extra
      if (!this.sentStatic.has(nid)) {
        spawns.push([nid, kind, faction, maxHp, level]);
        this.sentStatic.add(nid);
      }
    };
    for (const u of this.units) {
      if (!u.dead) add(u.nid, u instanceof Tank ? 1 : 0, u.faction, Math.round(u.cx), Math.round(u.cy), Math.ceil(u.hp), u.maxHp, u.level);
    }
    for (const h of this.helis) {
      if (!h.dead) add(h.nid, 2, h.faction, Math.round(h.cx), Math.round(h.cy), Math.ceil(h.hp), h.maxHp, 1);
    }
    // Forget dead units so the static set can't grow unbounded over a long game.
    if (this.sentStatic.size > live.size) {
      for (const nid of this.sentStatic) if (!live.has(nid)) this.sentStatic.delete(nid);
    }

    const snap: SnapMsg = {
      type: "snap",
      units: dyn,
      hurt,
      spawns,
      buildings: this.buildings
        .filter((b) => !b.dead)
        .map((b) => [
          b.nid,
          BUILDING_CODE[b.type],
          b.faction,
          b.col,
          b.row,
          Math.ceil(b.hp),
          b.maxHp,
          Math.round(b.buildProgress * 100),
        ]),
      own: this.map.flushDirty(),
      shots: this.pShots,
      booms: this.pBooms,
      pops: this.pPops,
      warns: this.pWarns,
      gold: { red: this.gold[RED], blue: this.gold[BLUE] },
      lvl: {
        red: this.levels[RED],
        blue: this.levels[BLUE],
        tankRed: this.tankLevels[RED],
        tankBlue: this.tankLevels[BLUE],
        turretRed: this.turretLevels[RED],
        turretBlue: this.turretLevels[BLUE],
      },
      share: this.map.share(BLUE),
      acts: this.myActs,
      period,
    };
    this.pShots = [];
    this.pBooms = [];
    this.pPops = [];
    this.pWarns = [];
    this.sendNet(snap);
  }

  /** Guest: render what the host says (converted to the mirrored view). */
  private applySnapshot(snap: SnapMsg): void {
    if (!this.remote) return;
    if (this.debug) this.lastSnapBytes = JSON.stringify(snap).length;
    // Pass raw arrays + flip flag: the mirror converts inline (no per-snap array
    // allocation). `spawns` carries static data once.
    this.remote.applySnapshot(snap.units, snap.spawns ?? [], snap.hurt ?? [], snap.buildings, this.flipped);
    // Buildings may stand where the host cleared a tree/rock — mirror that here
    // so decor doesn't peek out from under a remote building.
    for (const [, , , c, r] of snap.buildings) this.map.clearDecor(this.map.idx(c, this.viewRow(r)));
    for (const [i, owner] of snap.own) {
      this.map.setOwner(this.viewIdx(i), owner);
    }
    if (snap.own.length > 0) this.sfx("capture", 0.16);
    // Cosmetics are bounded so a furious battle can't bury the guest under
    // thousands of effect entities (the runaway cause of guest lag). Tracers
    // and booms are capped per snapshot; spawnEffect also enforces a global cap.
    const shots = snap.shots;
    const shotCap = Math.min(shots.length, 14);
    for (let k = 0; k < shotCap; k++) {
      const [x, y, tx, ty, big] = shots[k];
      this.spawnEffect(new Tracer(x, this.viewY(y), tx, this.viewY(ty), big === 1));
      this.sfx(big === 1 ? "tankshot" : `shot${1 + (Math.abs(x + y) % 3)}`, big === 1 ? 0.2 : 0.12);
    }
    const booms = snap.booms;
    const boomCap = Math.min(booms.length, 8);
    for (let k = 0; k < boomCap; k++) {
      const [x, y, big] = booms[k];
      this.explosionVisual(x, this.viewY(y), big === 1);
    }
    for (const [x, y] of snap.warns ?? []) {
      this.spawnEffect(new StrikeMarker(x, this.viewY(y), STRIKE_RADIUS, STRIKE_DELAY));
      this.sfx("click", 0.5);
    }
    for (const [x, y, text, colorIdx] of snap.pops) {
      this.spawnEffect(new ScorePopup(x, this.viewY(y), text, colorIdx === 1 ? "#ff8b7a" : COLORS.gold, 15));
    }
    this.gold[RED] = snap.gold.red;
    this.gold[BLUE] = snap.gold.blue;
    this.levels[RED] = snap.lvl.red;
    this.levels[BLUE] = snap.lvl.blue;
    this.tankLevels[RED] = snap.lvl.tankRed ?? 1;
    this.tankLevels[BLUE] = snap.lvl.tankBlue ?? 1;
    this.turretLevels[RED] = snap.lvl.turretRed ?? 1;
    this.turretLevels[BLUE] = snap.lvl.turretBlue ?? 1;
    this.blueShare = snap.share;
    // Anti-AFK: the host's action counter climbing means it's actively playing.
    const acts = snap.acts ?? 0;
    if (acts > this.lastSeenActs) {
      this.lastSeenActs = acts;
      this.oppActed = true;
    }
    this.updateHeliLoop(snap.units.some((u) => u[1] === 2));
  }

  /* ---------------------------------------------------------------- *
   * Input — one tap handler drives everything (desktop & mobile)
   * ---------------------------------------------------------------- */

  private handleTap(x: number, y: number): void {
    const mine = this.myFaction;

    if (this.hud.hitMute(x, y)) {
      this.toggleSound();
      return;
    }

    if (y >= MAP_H) {
      const btn = this.hud.hitButton(x, y);
      if (!btn) return;
      if (btn === "upgradeSoldier" || btn === "upgradeTank" || btn === "upgradeTurret") {
        this.requestUpgrade(btn === "upgradeTank" ? "tank" : btn === "upgradeTurret" ? "turret" : "soldier");
        return;
      }
      this.board.playSound("click", false, 0.4);
      this.mode = this.mode === btn ? null : btn;
      return;
    }

    if (!this.mode) return;

    if (this.mode === "strike") {
      if (this.myGold < COST.strike) {
        this.board.playSound("error", false, 0.4);
        return;
      }
      this.mode = null;
      track("use_airstrike", { mode: this.role });
      this.myActs++;
      if (this.role === "guest") {
        // back to host space: the guest's view is mirrored
        this.sendNet({ type: "cmd", cmd: "strike", x: Math.round(x), y: Math.round(this.viewY(y)) });
        this.board.playSound("click", false, 0.5);
        return;
      }
      this.gold[mine] -= COST.strike;
      this.scheduleStrike(x, y, mine);
      return;
    }

    if (this.mode === "helico") {
      if (this.myGold < COST.helico) {
        this.board.playSound("error", false, 0.4);
        return;
      }
      this.mode = null;
      track("use_helico", { mode: this.role });
      this.myActs++;
      if (this.role === "guest") {
        // x n'a pas besoin de conversion : le miroir invité n'inverse que y
        this.sendNet({ type: "cmd", cmd: "helico", x: Math.round(x) });
        this.board.playSound("click", false, 0.5);
        return;
      }
      this.gold[mine] -= COST.helico;
      this.spawnHeli(mine, x);
      return;
    }

    if (this.mode === "axis") {
      const c = clamp(Math.floor(x / TILE), 0, GRID_W - 1);
      this.axisCol[mine] = c;
      this.mode = null;
      track("set_axis", { mode: this.role });
      this.myActs++;
      this.board.playSound("click", false, 0.5);
      this.spawnEffect(new ScorePopup(x, y, "AXE D'ATTAQUE", "#ffe27a", 16));
      if (this.role === "guest") this.sendNet({ type: "cmd", cmd: "axis", col: c });
      return;
    }

    // Build
    const c = Math.floor(x / TILE);
    const r = Math.floor(y / TILE);
    const kind = this.mode;
    const cost = COST[kind];
    const i = this.map.idx(c, r);
    const occupied = this.role === "guest" ? this.remote?.buildingAtTile(c, r) ?? false : this.buildingAt.has(i);
    const buildable = this.map.isLand(c, r) && this.map.owner[i] === mine && !occupied && !this.map.hasChest(i);
    if (!buildable) {
      this.board.playSound("error", false, 0.4);
      this.spawnEffect(new ScorePopup(x, y, "CASE INVALIDE", "#ff8b7a", 14));
      return;
    }
    if (this.myGold < cost) {
      this.board.playSound("error", false, 0.4);
      this.spawnEffect(new ScorePopup(x, y, "PAS ASSEZ D'OR", "#ff8b7a", 14));
      return;
    }
    this.mode = null;
    track("build", { type: kind, mode: this.role });
    this.myActs++;
    if (this.role === "guest") {
      // The host owns the truth: it validates, spends and spawns
      // (row converted back to host space — the guest's view is mirrored)
      this.sendNet({ type: "cmd", cmd: "build", kind, c, r: this.viewRow(r) });
      this.board.playSound("build", false, 0.5);
      return;
    }
    this.gold[mine] -= cost;
    this.placeBuilding(mine, kind, c, r);
    this.board.playSound("build", false, 0.5);
    const center = this.map.tileCenter(c, r);
    this.spawnEffect(new Shockwave(center.x, center.y, 50, "#ffffff", 0.35));
  }

  private requestUpgrade(kind: UpgradeKind): void {
    const cost = this.upgradeCostFor(this.myFaction, kind);
    if (this.myGold < cost) {
      this.board.playSound("error", false, 0.4);
      return;
    }
    track("upgrade", { kind, level: this.upgradeLevelFor(this.myFaction, kind) + 1, mode: this.role });
    this.myActs++;
    if (this.role === "guest") {
      this.sendNet({ type: "cmd", cmd: "upgrade", kind });
      this.board.playSound("build", false, 0.5);
      return;
    }
    this.buyUpgrade(this.myFaction, kind);
  }

  private upgradeLevelFor(f: Faction, kind: UpgradeKind): number {
    if (kind === "tank") return this.tankLevels[f];
    if (kind === "turret") return this.turretLevels[f];
    return this.levels[f];
  }

  private upgradeCostFor(f: Faction, kind: UpgradeKind): number {
    if (kind === "tank") return tankUpgradeCost(this.tankLevels[f]);
    if (kind === "turret") return turretUpgradeCost(this.turretLevels[f]);
    return soldierUpgradeCost(this.levels[f]);
  }

  /** Solo/host: pay and raise one faction upgrade level. */
  private buyUpgrade(f: Faction, kind: UpgradeKind): void {
    const cost = this.upgradeCostFor(f, kind);
    if (this.gold[f] < cost) return;
    this.gold[f] -= cost;
    if (kind === "tank") this.tankLevels[f]++;
    else if (kind === "turret") this.turretLevels[f]++;
    else this.levels[f]++;
    const hq = this.buildings.find((b) => !b.dead && b.type === "hq" && b.faction === f);
    const x = hq ? hq.cx : VIEW_W / 2;
    const y = hq ? hq.cy : MAP_H / 2;
    const label = kind === "tank" ? "TANKS" : kind === "turret" ? "TOURELLES" : "SOLDATS";
    const level = kind === "tank" ? this.tankLevels[f] : kind === "turret" ? this.turretLevels[f] : this.levels[f];
    this.popup(x, y - 30, `${label} NIVEAU ${level}`, 0);
    this.spawnEffect(new Shockwave(x, y, 70, COLORS.gold, 0.45));
    this.sfx("coin", 0.5);
  }

  /* ---------------------------------------------------------------- *
   * GameAPI
   * ---------------------------------------------------------------- */

  axisX(f: Faction): number {
    return this.axisCol[f] * TILE + TILE / 2;
  }

  /** +1 in host space, -1 when the view is mirrored (guest). */
  flipY(): number {
    return this.flipped ? -1 : 1;
  }

  /** Mirror a Y/px coordinate into this client's space (identity on the host). */
  private mirrorY(y: number): number {
    return this.flipped ? MAP_H - y : y;
  }

  nearestEnemy(x: number, y: number, f: Faction, range: number): Target | null {
    const seek = enemyOf(f);
    const c0 = Math.floor(x / TILE);
    const r0 = Math.floor(y / TILE);
    const span = Math.ceil(range / TILE) + 1;
    let best: Target | null = null;
    let bestD = Infinity;
    for (let r = r0 - span; r <= r0 + span; r++) {
      if (r < 0 || r >= GRID_H) continue;
      for (let c = c0 - span; c <= c0 + span; c++) {
        if (c < 0 || c >= GRID_W) continue;
        const cell = this.buckets[r * GRID_W + c];
        if (!cell) continue;
        for (const t of cell) {
          if (t.dead || t.faction !== seek) continue;
          const d = Math.hypot(t.cx - x, t.cy - y) - t.radius;
          if (d <= range && d < bestD) {
            bestD = d;
            best = t;
          }
        }
      }
    }
    return best;
  }

  fireBullet(x: number, y: number, target: Target, dmg: number, f: Faction, big: boolean): void {
    const b = new Bullet(this, x, y, target, dmg, f, big);
    this.bullets.push(b);
    this.board.addEntity(b);
    if (this.role === "host") {
      this.pShots.push([Math.round(x), Math.round(y), Math.round(target.cx), Math.round(target.cy), big ? 1 : 0]);
    }
  }

  spawnSoldier(f: Faction, x: number, y: number, level?: number): void {
    if (this.counts[f].soldiers >= MAX_SOLDIERS) return;
    this.counts[f].soldiers++;
    const u = new Soldier(this, f, x, y, level ?? this.levels[f]);
    u.nid = this.nextNid++;
    this.units.push(u);
    this.board.addEntity(u);
  }

  spawnTank(f: Faction, x: number, y: number, level?: number): void {
    if (this.counts[f].tanks >= MAX_TANKS) return;
    this.counts[f].tanks++;
    const u = new Tank(this, f, x, y, level ?? this.tankLevels[f]);
    u.nid = this.nextNid++;
    this.units.push(u);
    this.board.addEntity(u);
  }

  /** Sortie d'hélico : décolle de la ligne arrière sur la colonne choisie. */
  spawnHeli(f: Faction, x: number): void {
    if (this.helis.filter((h) => !h.dead && h.faction === f).length >= MAX_HELIS) return;
    const hq = this.buildings.find((b) => !b.dead && b.type === "hq" && b.faction === f);
    const y = hq ? hq.cy : f === RED ? 80 : MAP_H - 80;
    const h = new Helicopter(this, f, clamp(x, 24, VIEW_W - 24), y);
    h.nid = this.nextNid++;
    this.helis.push(h);
    this.board.addEntity(h);
    this.popup(h.cx, h.cy - 40, "HELICO !", f === this.myFaction ? 0 : 1);
    this.sfx("build", 0.4);
  }

  nearestAirEnemy(x: number, y: number, f: Faction, range: number): Target | null {
    const seek = enemyOf(f);
    let best: Target | null = null;
    let bestD = Infinity;
    for (const h of this.helis) {
      if (h.dead || h.faction !== seek) continue;
      const d = Math.hypot(h.cx - x, h.cy - y) - h.radius;
      if (d <= range && d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  tryConvert(x: number, y: number, f: Faction): void {
    const res = this.map.convertAtPx(x, y, f);
    if (!res) return;
    this.sfx("capture", 0.16);
    this.gold[f] += 1;
    if (res.chest > 0) {
      this.gold[f] += res.chest;
      this.board.playSound("coin", false, 0.5);
      this.popup(x, y, `+${res.chest} OR`, 0);
      this.spawnEffect(new Shockwave(x, y, 44, COLORS.gold, 0.4));
    }
  }

  impact(x: number, y: number, big: boolean): void {
    const n = big ? 6 : 3;
    for (let k = 0; k < n; k++) {
      this.spawnEffect(
        new Particle(x, y, rand(0, TAU), rand(40, big ? 160 : 110), pick(["#ffb13d", "#ff7a3d", "#fff2a8"]), {
          life: rand(0.15, 0.35),
          size: big ? 3.5 : 2.5,
        })
      );
    }
  }

  notifyKill(victim: Target, killer: Faction): void {
    if (victim.dead) return;
    victim.dead = true;

    if (victim instanceof Helicopter) {
      this.explosion(victim.cx, victim.cy, true);
      this.gold[killer] += 15;
      this.killsBy[killer]++;
      return;
    }

    if (victim instanceof Unit) {
      const tank = victim instanceof Tank;
      this.counts[victim.faction][tank ? "tanks" : "soldiers"]--;
      this.explosion(victim.cx, victim.cy, tank);
      this.gold[killer] += tank ? 10 : 3;
      this.killsBy[killer]++;
      return;
    }

    // Building destroyed
    const b = victim as Building;
    this.buildingAt.delete(this.map.idx(b.col, b.row));
    this.explosion(b.cx, b.cy, true);
    this.board.playSound("explosion_big", false, 0.55);
    this.gold[killer] += b.type === "turret" ? 25 : b.type === "factory" ? 30 : 20;
    if (b.type === "hq") this.endGame(killer);
  }

  sfx(name: string, volume = 0.3): void {
    const now = this.elapsed;
    const last = this.sfxLast.get(name) ?? -1;
    if (now - last < 0.07) return;
    this.sfxLast.set(name, now);
    this.board.playSound(name, false, volume);
  }

  /** Popup visible on both sides (recorded for the guest in multi). */
  private popup(x: number, y: number, text: string, colorIdx: 0 | 1): void {
    this.spawnEffect(new ScorePopup(x, y, text, colorIdx === 1 ? "#ff8b7a" : COLORS.gold, 15));
    if (this.role === "host") this.pPops.push([Math.round(x), Math.round(y), text, colorIdx]);
  }

  /* ---------------------------------------------------------------- *
   * Airstrikes (solo + host authoritative; guests get warn/boom events)
   * ---------------------------------------------------------------- */

  private scheduleStrike(x: number, y: number, f: Faction): void {
    this.strikes.push({ x, y, t: STRIKE_DELAY, faction: f });
    this.spawnEffect(new StrikeMarker(x, y, STRIKE_RADIUS, STRIKE_DELAY));
    this.popup(x, y - STRIKE_RADIUS - 8, "FRAPPE !", 1);
    if (this.role === "host") this.pWarns.push([Math.round(x), Math.round(y)]);
    this.sfx("click", 0.5);
  }

  private updateStrikes(dt: number): void {
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.t -= dt;
      if (s.t > 0) continue;
      this.strikes.splice(i, 1);
      this.applyStrike(s.x, s.y, s.faction);
    }
  }

  /** The blast hits EVERYTHING in the radius, both sides included. */
  private applyStrike(x: number, y: number, f: Faction): void {
    this.explosion(x, y, true);
    this.spawnEffect(new Shockwave(x, y, STRIKE_RADIUS * 2.2, "#ffffff", 0.6, 5));
    this.board.playSound("explosion_big", false, 0.6);

    for (const u of [...this.units]) {
      if (u.dead || u.distTo(x, y) > STRIKE_RADIUS + u.radius) continue;
      u.hp -= STRIKE_DMG_UNIT;
      if (u.hp <= 0) this.notifyKill(u, u.faction === f ? enemyOf(f) : f);
    }
    for (const b of [...this.buildings]) {
      if (b.dead || b.distTo(x, y) > STRIKE_RADIUS + b.radius) continue;
      if (b.type === "hq") continue;
      b.hp -= STRIKE_DMG_BUILDING;
      if (b.hp <= 0) this.notifyKill(b, b.faction === f ? enemyOf(f) : f);
    }
  }

  /* ---------------------------------------------------------------- *
   * Main loop
   * ---------------------------------------------------------------- */

  update(delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.elapsed += dt;

    if (this.role !== "guest") {
      this.rebuildBuckets();
      // Buildings spawn/fire at their faction's current upgrade levels.
      for (const b of this.buildings) {
        b.soldierLevel = this.levels[b.faction];
        b.tankLevel = this.tankLevels[b.faction];
        b.turretLevel = this.turretLevels[b.faction];
      }
    }

    super.update(delta); // updates every entity + timers

    if (!this.ended) {
      if (this.role !== "guest") {
        this.updateStrikes(dt);

        this.incomeT -= dt;
        if (this.incomeT <= 0) {
          this.incomeT = INCOME_EVERY;
          this.gold[BLUE] += 2;
          // Solo: the AI's war chest grows with time — stall and it buries you
          this.gold[RED] += this.role === "solo" ? 2 + Math.min(2, (this.elapsed / 60) * 0.5) : 2;
        }

        if (this.role === "solo") {
          this.brainT -= dt;
          if (this.brainT <= 0) {
            this.brainT = BRAIN_EVERY;
            this.redBrain();
          }
          this.redPanic(dt);
        }

        this.updateHqDefense(dt);
        this.blueShare = this.map.share(BLUE);
        this.updateHeliLoop(this.helis.some((h) => !h.dead));
      }

      if (this.role === "host") {
        this.snapT -= dt;
        if (this.snapT <= 0) {
          // Mild throttle as the army grows (payload is already ~halved by the
          // static/dynamic split). The guest interpolates over this exact
          // period, so motion stays smooth at any rate.
          // Bandwidth is tiny (~3 KB/snap), so prioritise LOW LATENCY: send
          // often. The cost is CPU only, negligible at this payload size.
          const n = this.units.length;
          const period = n > 320 ? 0.1 : n > 180 ? 0.08 : 0.067; // ~10–15 Hz
          this.snapT = period;
          this.sendSnapshot(period);
        }
      }

      // Anti-AFK: cancel ONLY when the opponent never plays at all (AFK from
      // the start). Once they've issued a single order, going quiet later is a
      // legitimate choice and must NOT void the match. The guest learns of host
      // actions via snap.acts, the host of guest orders via cmd messages.
      if (this.role !== "solo" && this.inited && !this.voided && !this.oppActed && this.elapsed > IDLE_LIMIT) {
        this.voidMatch("Adversaire inactif", true);
      }

      if (this.role === "guest" && !this.inited) {
        this.readyT -= dt;
        if (this.readyT <= 0) {
          this.readyT = 0.6;
          this.sendNet({ type: "ready", name: this.myName, uid: this.myUid });
        }
      }

      const mine = this.myFaction;
      const m = this.map.tileCenter(this.axisCol[mine], 0);
      // frontRowFromTop: on every screen "my" army pushes upward (the
      // guest's view is mirrored), so the marker sits on my furthest row
      this.axisMarker = {
        x: m.x,
        y: clamp(this.map.frontRowFromTop(mine, this.axisCol[mine]) * TILE, 60, MAP_H - 60),
      };
    }

    if (this.fpsMeter) {
      const units = this.role === "guest" ? this.remote?.unitCount ?? 0 : this.units.length;
      const net =
        this.role === "guest"
          ? `  ${(this.lastSnapBytes / 1024).toFixed(1)}KB gap:${this.remote?.lastGapMs ?? 0}ms buf:${this.remote?.bufferMs ?? 0}ms`
          : "";
      this.fpsMeter.info = `${this.role} u:${units}${net}`;
    }

    this.sweepDead();
    this.bringToFront();
  }

  /* ---------------------------------------------------------------- *
   * Red AI (solo only)
   * ---------------------------------------------------------------- */

  private updateHqDefense(_dt: number): void {
    for (const f of [RED, BLUE] as const) {
      const hq = this.buildings.find((b) => !b.dead && b.type === "hq" && b.faction === f);
      if (!hq) {
        this.hqLastHp[f] = 0;
        continue;
      }

      const last = this.hqLastHp[f];
      if (last <= 0) {
        this.hqLastHp[f] = hq.hp;
        continue;
      }

      if (hq.hp < last && !this.hqDefenseUsed[f]) {
        this.hqDefenseUsed[f] = true;
        this.spawnHqDefenseWave(hq);
      }
      this.hqLastHp[f] = hq.hp;
    }
  }

  private spawnHqDefenseWave(hq: Building): void {
    const dir = (hq.faction === RED ? 1 : -1) * this.flipY();
    const enemy = enemyOf(hq.faction);
    const attackers = this.units.filter(
      (u) => !u.dead && u.faction === enemy && u.distTo(hq.cx, hq.cy) <= HQ_DEFENSE_RADIUS
    );
    const nearest = attackers.sort((a, b) => a.distTo(hq.cx, hq.cy) - b.distTo(hq.cx, hq.cy))[0];
    if (nearest) this.axisCol[hq.faction] = clamp(Math.floor(nearest.cx / TILE), 0, GRID_W - 1);

    const attackersPower = attackers.reduce((sum, u) => sum + (u instanceof Tank ? 3 : 1), 0);
    const soldiers = clamp(
      Math.round(HQ_DEFENSE_MIN_SOLDIERS + attackersPower * 0.45),
      HQ_DEFENSE_MIN_SOLDIERS,
      HQ_DEFENSE_MAX_SOLDIERS
    );
    const tanks = clamp(
      Math.round(HQ_DEFENSE_MIN_TANKS + attackersPower / 18),
      HQ_DEFENSE_MIN_TANKS,
      HQ_DEFENSE_MAX_TANKS
    );

    for (let i = 0; i < soldiers; i++) {
      const spread = i % 2 === 0 ? -1 : 1;
      this.spawnSoldier(
        hq.faction,
        hq.cx + spread * srand(18, 150),
        hq.cy + dir * srand(35, 165),
        this.levels[hq.faction]
      );
    }
    for (let i = 0; i < tanks; i++) {
      this.spawnTank(hq.faction, hq.cx + srand(-130, 130), hq.cy + dir * srand(55, 150));
    }
    this.popup(hq.cx, hq.cy - 54, `DEFENSE QG +${soldiers}`, hq.faction === RED ? 1 : 0);
    this.spawnEffect(new Shockwave(hq.cx, hq.cy, 150, "#ffffff", 0.55));
    this.sfx("build", 0.5);
  }

  /**
   * Anti-rush reflex, checked every frame: blue troops close to the red HQ
   * (or the HQ taking hits) trigger an instant garrison + axis recall.
   */
  private redPanic(dt: number): void {
    this.garrisonCd -= dt;
    this.alertT -= dt;
    if (this.alertT > 0) return;
    this.alertT = 0.4; // probe a couple of times per second

    const hq = this.buildings.find((b) => !b.dead && b.type === "hq" && b.faction === RED);
    if (!hq) return;
    // A lone scout is not an assault: panic on real pressure only
    let threats = 0;
    let threatX = hq.cx;
    for (const u of this.units) {
      if (!u.dead && u.faction === BLUE && u.distTo(hq.cx, hq.cy) < HQ_ALERT_RADIUS) {
        threats++;
        threatX = u.cx;
      }
    }
    const underFire = hq.hp < hq.maxHp;
    if (threats < 3 && !underFire) return;

    // Recall the army toward the breach
    this.axisCol[RED] = clamp(Math.floor(threatX / TILE), 0, GRID_W - 1);

    // Emergency garrison around the HQ
    if (this.garrisonCd <= 0 && this.gold[RED] >= GARRISON_COST) {
      this.garrisonCd = GARRISON_CD;
      this.gold[RED] -= GARRISON_COST;
      for (let i = 0; i < 5; i++) {
        this.spawnSoldier(RED, hq.cx + rand(-50, 50), hq.cy + rand(20, 60));
      }
      this.popup(hq.cx, hq.cy - 44, "GARNISON !", 1);
      this.sfx("build", 0.45);
    }

    // A turret at the gates if the walls are bare
    const guards = this.buildings.filter(
      (b) => !b.dead && b.faction === RED && b.type === "turret" && b.distTo(hq.cx, hq.cy) < TILE * 3.2
    ).length;
    if (guards < 2 && this.gold[RED] >= COST.turret) {
      for (let tries = 0; tries < 10; tries++) {
        const c = clamp(hq.col + randInt(-2, 2), 0, GRID_W - 1);
        const r = clamp(hq.row + randInt(0, 2), 1, GRID_H - 2);
        const i = this.map.idx(c, r);
        if (this.map.isLand(c, r) && this.map.owner[i] === RED && !this.buildingAt.has(i) && !this.map.hasChest(i)) {
          this.gold[RED] -= COST.turret;
          this.placeBuilding(RED, "turret", c, r);
          break;
        }
      }
    }
  }

  private redBrain(): void {
    const intel = this.redIntel();
    this.aiPosture = intel.posture;
    this.axisCol[RED] = intel.axis;

    // Short grace so the player can take the early initiative.
    if (this.elapsed < AI_GRACE) return;

    const reserve = intel.infantryFlood ? 25 : intel.posture === "defend" ? 45 : AI_MIN_RESERVE;

    // Strike only when it really changes the fight: packed troops first,
    // then exposed production/defense clusters if the player turtles.
    if (this.gold[RED] >= COST.strike + reserve) {
      const target = this.bestRedStrikeTarget(intel);
      if (target) {
        this.gold[RED] -= COST.strike;
        this.scheduleStrike(target.x, target.y, RED);
        return;
      }
    }

    // Helico punishes players who skip anti-air, but it becomes rarer once
    // blue has built enough turrets to avoid wasting gold.
    const antiAirGap = intel.blueTurrets < 2 || intel.blueFactories + intel.blueBarracks >= intel.blueTurrets + 3;
    const wantsHeli = antiAirGap && intel.posture !== "defend" && Math.random() < (intel.blueTurrets === 0 ? 0.75 : 0.38);
    if (wantsHeli && this.gold[RED] >= COST.helico + reserve) {
      this.gold[RED] -= COST.helico;
      this.spawnHeli(RED, this.columnCenter(intel.opportunityCol + randInt(-1, 1)));
      return;
    }

    // Upgrade whatever answers the current pressure best.
    const upgradeKind: UpgradeKind =
      intel.infantryFlood || intel.blueSoldiers > intel.redSoldiers + 8
        ? "turret"
        : intel.blueTanks >= 2 || intel.blueFactories >= 2
          ? "tank"
          : "soldier";
    const upCost = this.upgradeCostFor(RED, upgradeKind);
    const wantsUpgrade =
      (intel.blueBarracks >= 5 ||
        intel.redShare > 0.54 ||
        this.levels[BLUE] > this.levels[RED] ||
        this.tankLevels[BLUE] > this.tankLevels[RED] ||
        this.turretLevels[BLUE] > this.turretLevels[RED]) &&
      this.gold[RED] >= upCost + reserve;
    if (wantsUpgrade) {
      this.buyUpgrade(RED, upgradeKind);
      return;
    }

    const maxBarracks = Math.min(6, 4 + Math.floor(this.elapsed / 90));
    let want: BuildingType | null = null;
    if (intel.infantryFlood && intel.redTurrets < 7 && this.gold[RED] >= COST.turret + 5) {
      want = "turret";
    } else if (intel.infantryFlood && intel.redBarracks < Math.max(5, intel.blueBarracks - 1) && this.gold[RED] >= COST.barracks + 5) {
      want = "barracks";
    } else if (intel.posture === "defend" && intel.redTurrets < 5 && this.gold[RED] >= COST.turret + 15) {
      want = "turret";
    } else if ((intel.blueTanks >= 2 || intel.blueFactories >= 2) && intel.redFactories < 2 && this.gold[RED] >= COST.factory + reserve) {
      want = "factory";
    } else if (intel.redBarracks < maxBarracks && this.gold[RED] >= COST.barracks + reserve * 0.4) {
      want = "barracks";
    } else if (intel.redTurrets < 4 && this.gold[RED] >= COST.turret + reserve) {
      want = "turret";
    } else if (intel.redFactories < (intel.posture === "tech" ? 3 : 2) && this.gold[RED] >= COST.factory + reserve) {
      want = "factory";
    } else if (this.gold[RED] >= COST.barracks + reserve + 30) {
      want = "barracks";
    }
    if (!want) return;

    const built = this.tryRedBuild(want, intel);
    if (built) this.gold[RED] -= COST[want];
  }

  private redIntel(): RedAiIntel {
    let pressureCol = 8;
    let pressureScore = -Infinity;
    let opportunityCol = 8;
    let opportunityScore = -Infinity;
    let deepestBlueRow = GRID_H;

    for (let c = 0; c < GRID_W; c++) {
      if (!this.map.isLand(c, 1) && !this.map.isLand(c, GRID_H - 2)) continue;
      const front = this.map.blueFrontRow(c);
      if (front < deepestBlueRow) deepestBlueRow = front;
      let blueUnits = 0;
      let redUnits = 0;
      for (const u of this.units) {
        if (u.dead || Math.abs(Math.floor(u.cx / TILE) - c) > 1) continue;
        if (u.faction === BLUE) blueUnits += u instanceof Tank ? 2.2 : 1;
        else redUnits += u instanceof Tank ? 2 : 1;
      }
      const blueDepth = front < GRID_H ? GRID_H - front : 0;
      const pressure = blueDepth * 1.7 + blueUnits * 1.8 - redUnits * 0.7;
      const opportunity = front < GRID_H ? front * 1.2 - blueUnits * 0.6 : -Infinity;
      if (pressure > pressureScore) {
        pressureScore = pressure;
        pressureCol = c;
      }
      if (opportunity > opportunityScore) {
        opportunityScore = opportunity;
        opportunityCol = c;
      }
    }

    const redShare = this.map.share(RED);
    const alive = this.buildings.filter((b) => !b.dead);
    const count = (f: Faction, t: BuildingType) => alive.filter((b) => b.faction === f && b.type === t).length;
    const blueTanks = this.units.filter((u) => !u.dead && u.faction === BLUE && u instanceof Tank).length;
    const blueSoldiers = this.units.filter((u) => !u.dead && u.faction === BLUE && !(u instanceof Tank)).length;
    const redSoldiers = this.units.filter((u) => !u.dead && u.faction === RED && !(u instanceof Tank)).length;
    const blueHelis = this.helis.filter((h) => !h.dead && h.faction === BLUE).length;
    const blueTurrets = count(BLUE, "turret");
    const blueFactories = count(BLUE, "factory");
    const blueBarracks = count(BLUE, "barracks");
    const redTurrets = count(RED, "turret");
    const redFactories = count(RED, "factory");
    const redBarracks = count(RED, "barracks");
    const infantryFlood =
      blueBarracks >= redBarracks + 2 ||
      blueBarracks >= 5 ||
      blueSoldiers >= redSoldiers + 10 ||
      (blueSoldiers >= 18 && blueTanks === 0);

    let posture: AiPosture = "counter";
    if (redShare < 0.46 || deepestBlueRow <= 7 || blueHelis > 0 || infantryFlood) posture = "defend";
    else if (redShare > 0.57) posture = "press";
    else if (blueFactories >= 2 || blueTanks >= 3 || blueTurrets >= 5) posture = "tech";

    let axis = posture === "press" ? opportunityCol : pressureCol;
    if (posture === "tech" && Math.random() < 0.45) axis = opportunityCol;
    if (Math.random() < AI_REPLAN_VARIANCE) axis = clamp(axis + randInt(-1, 1), 0, GRID_W - 1);

    return {
      posture,
      axis,
      pressureCol,
      opportunityCol,
      blueTanks,
      blueSoldiers,
      blueTurrets,
      blueFactories,
      blueBarracks,
      blueHelis,
      redSoldiers,
      redTurrets,
      redFactories,
      redBarracks,
      redShare,
      deepestBlueRow,
      infantryFlood,
    };
  }

  private bestRedStrikeTarget(intel: RedAiIntel): { x: number; y: number } | null {
    const pack = this.densestBluePack(intel.infantryFlood || intel.posture === "defend" ? 3 : 4);
    if (pack) return pack;

    if (intel.blueTurrets + intel.blueFactories + intel.blueBarracks < 5) return null;
    let best: { x: number; y: number; score: number } | null = null;
    for (const b of this.buildings) {
      if (b.dead || b.faction !== BLUE || b.type === "hq") continue;
      let score = b.type === "turret" ? 2.3 : b.type === "factory" ? 2.8 : 1.6;
      for (const other of this.buildings) {
        if (other.dead || other.faction !== BLUE || other === b || other.type === "hq") continue;
        if (other.distTo(b.cx, b.cy) < STRIKE_RADIUS * 1.35) score += other.type === "factory" ? 2 : 1;
      }
      if (!best || score > best.score) best = { x: b.cx, y: b.cy, score };
    }
    return best && best.score >= 4.4 ? { x: best.x, y: best.y } : null;
  }

  private tryRedBuild(kind: BuildingType, intel: RedAiIntel): boolean {
    const axis = kind === "turret" ? intel.pressureCol : this.axisCol[RED];
    const rowBias = kind === "turret" ? [1, 2, 3, 4] : kind === "factory" ? [4, 5, 6, 3] : [2, 3, 4, 5];
    for (let tries = 0; tries < 18; tries++) {
      const c = clamp(axis + randInt(-3, 3), 0, GRID_W - 1);
      const front = this.map.blueFrontRow(c);
      const r = clamp(front - pick(rowBias), 1, GRID_H - 2);
      if (this.canRedBuildAt(c, r)) {
        this.placeBuilding(RED, kind, c, r);
        return true;
      }
    }

    // Fallback around the HQ so saved gold still becomes useful defense.
    const hq = this.buildings.find((b) => !b.dead && b.type === "hq" && b.faction === RED);
    if (!hq) return false;
    for (let tries = 0; tries < 12; tries++) {
      const c = clamp(hq.col + randInt(-4, 4), 0, GRID_W - 1);
      const r = clamp(hq.row + randInt(1, 5), 1, GRID_H - 2);
      if (this.canRedBuildAt(c, r)) {
        this.placeBuilding(RED, kind, c, r);
        return true;
      }
    }
    return false;
  }

  private canRedBuildAt(c: number, r: number): boolean {
    const i = this.map.idx(c, r);
    return this.map.isLand(c, r) && this.map.owner[i] === RED && !this.buildingAt.has(i) && !this.map.hasChest(i);
  }

  private columnCenter(c: number): number {
    return clamp(c, 0, GRID_W - 1) * TILE + TILE / 2;
  }

  /** Best airstrike target: ≥5 blue units packed in a 3×3-tile window. */
  private densestBluePack(minUnits = 4): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestCount = minUnits;
    for (let r = 1; r < GRID_H - 1; r++) {
      for (let c = 1; c < GRID_W - 1; c++) {
        let count = 0;
        let sx = 0;
        let sy = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const cell = this.buckets[(r + dr) * GRID_W + c + dc];
            if (!cell) continue;
            for (const t of cell) {
              if (!t.dead && t.faction === BLUE && t instanceof Unit) {
                count++;
                sx += t.cx;
                sy += t.cy;
              }
            }
          }
        }
        if (count > bestCount) {
          bestCount = count;
          best = { x: sx / count, y: sy / count };
        }
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- *
   * World helpers
   * ---------------------------------------------------------------- */

  private placeBuilding(f: Faction, type: BuildingType, c: number, r: number, instant = false): void {
    const b = new Building(this, f, type, c, r, instant);
    b.nid = this.nextNid++;
    b.soldierLevel = this.levels[f];
    b.tankLevel = this.tankLevels[f];
    b.turretLevel = this.turretLevels[f];
    this.buildings.push(b);
    this.buildingAt.set(this.map.idx(c, r), b);
    this.map.clearDecor(this.map.idx(c, r)); // a tree/rock no longer blocks — clear it under the building
    this.board.addEntity(b);
  }

  private rebuildBuckets(): void {
    this.buckets = new Array(GRID_W * GRID_H);
    const put = (t: Target) => {
      if (t.dead) return;
      const c = clamp(Math.floor(t.cx / TILE), 0, GRID_W - 1);
      const r = clamp(Math.floor(t.cy / TILE), 0, GRID_H - 1);
      const i = r * GRID_W + c;
      (this.buckets[i] ||= []).push(t);
    };
    for (const u of this.units) put(u);
    for (const b of this.buildings) put(b);
  }

  /** Explosion with gameplay record (host) — guests get it via `booms`. */
  private explosion(x: number, y: number, big: boolean): void {
    this.explosionVisual(x, y, big);
    if (this.role === "host") this.pBooms.push([Math.round(x), Math.round(y), big ? 1 : 0]);
  }

  private explosionVisual(x: number, y: number, big: boolean): void {
    // Fewer particles when the effect pool is already crowded — keeps big
    // fights cheap (especially on the guest) without losing the punch.
    const crowded = this.effects.length > MAX_EFFECTS * 0.6;
    const count = crowded ? (big ? 8 : 4) : big ? 22 : 11;
    for (let k = 0; k < count; k++) {
      this.spawnEffect(
        new Particle(x, y, rand(0, TAU), rand(50, big ? 320 : 200), pick(["#ffb13d", "#ff7a3d", "#ffe27a", "#5a5a5a"]), {
          life: rand(0.25, big ? 0.8 : 0.5),
          size: rand(2, big ? 5 : 3.5),
        })
      );
    }
    this.spawnEffect(new Shockwave(x, y, big ? 90 : 44, "#ffd28a", big ? 0.5 : 0.3));
    this.sfx(big ? "explosion2" : "explosion1", big ? 0.4 : 0.25);
  }

  /** Add a cosmetic entity, unless the live-effect cap is reached (prevents a
   *  runaway entity count from tanking the frame rate during huge battles). */
  private spawnEffect(e: GameObject): void {
    if (this.effects.length >= MAX_EFFECTS) return;
    this.effects.push(e);
    this.board.addEntity(e);
  }

  private sweepDead(): void {
    this.sweep(this.units);
    this.sweep(this.bullets);
    this.sweep(this.buildings);
    this.sweep(this.helis);
    this.sweep(this.effects);
  }

  /** Boucle sonore du rotor tant qu'au moins un hélico est en vol. */
  private updateHeliLoop(active: boolean): void {
    if (active === this.heliLoopOn) return;
    this.heliLoopOn = active;
    if (active) this.board.playSound("helico", true, 0.22);
    else this.board.stopSound("helico", true, 400);
  }

  private sweep<T extends GameObject>(arr: T[]): void {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].dead) {
        this.board.removeEntity(arr[i]);
        arr.splice(i, 1);
      }
    }
  }

  /** HUD and faders stay above freshly spawned entities. */
  private bringToFront(): void {
    for (const e of this.topEntities) {
      const i = this.board.entities.indexOf(e);
      if (i > -1 && i !== this.board.entities.length - 1) {
        this.board.entities.splice(i, 1);
        this.board.entities.push(e);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * End of the war
   * ---------------------------------------------------------------- */

  /** Solo/host: authoritative end. */
  private endGame(winner: Faction): void {
    if (this.ended) return;
    if (this.role === "host") {
      // One last snapshot so the guest sees the HQ blow up, then the verdict
      this.sendSnapshot();
      this.sendNet({
        type: "end",
        winner,
        time: this.elapsed,
        share: this.map.share(BLUE),
        kills: { red: this.killsBy[RED], blue: this.killsBy[BLUE] },
      });
    }
    this.showEnd(winner, this.elapsed, this.map.share(BLUE));
  }

  /** Common display path (guest gets the verdict from the host). */
  private showEnd(winner: Faction, time: number, blueShare: number): void {
    if (this.ended) return;
    this.ended = true;
    this.mode = null;
    this.axisMarker = null;
    this.updateHeliLoop(false);
    const win = winner === this.myFaction;
    this.board.stopSound("music_battle", true, 800);

    // Ranked-fairness verdict: a match only counts when it's a genuine, full
    // contest between two distinct, active players.
    const multi = this.role !== "solo";
    let ranked = multi;
    let reason = "";
    if (this.voided) {
      ranked = false;
      reason = this.voidReason || "Partie annulee";
    } else if (multi) {
      if (this.sameIp) {
        ranked = false;
        reason = "Meme reseau";
      } else if (time < MIN_RANKED_DURATION) {
        ranked = false;
        reason = "Partie trop courte";
      } else if (!this.oppActed) {
        ranked = false;
        reason = "Adversaire inactif";
      } else if (!this.enemyUid) {
        // The Cloud Function needs both players signed in to validate a result.
        ranked = false;
        reason = "Adversaire non connecte";
      }
    }
    if (ranked || !multi) track("match_ranked", { mode: this.role });
    else track("match_unranked", { mode: this.role, reason });

    if (this.voided) this.board.playSound("error", false, 0.4);
    else this.board.playSound(win ? "victory" : "defeat", false, 0.6);

    const data = {
      win,
      time,
      share: this.myFaction === BLUE ? blueShare : 1 - blueShare,
      kills: this.killsBy[this.myFaction],
      losses: this.killsBy[enemyOf(this.myFaction)],
      multi,
      faction: this.myFaction,
      ranked,
      voided: this.voided,
      reason,
      matchId: this.matchId,
      enemyUid: this.enemyUid,
    };
    this.addTimer(
      this.voided ? 1200 : 2200,
      () => {
        const out = new Fader(0, 1, 700, "#08111f", () => {
          this.board.moveToStep("end", data);
        });
        this.board.addEntity(out);
        this.topEntities.push(out);
      },
      false
    );
  }
}
