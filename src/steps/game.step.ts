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
import { TileMap } from "../entities/tilemap";
import { Bullet, Soldier, Tank, Unit } from "../entities/units";
import { Building, BUILDING_CODE, BuildingType } from "../entities/buildings";
import { Helicopter } from "../entities/helicopter";
import { Fader, FpsMeter, Particle, ScorePopup, Shockwave, StrikeMarker, Tracer } from "../entities/effects";
import { BuildMode, Hud, HudState } from "../entities/hud";
import { GameObject } from "../entities/gameobject";
import { RemoteWorld } from "../entities/remote";
import { CmdMsg, EndMsg, FrameMsg, GameMsg, gameData, InitMsg, IpMsg, MultiData, SnapMsg, VoidMsg } from "../network";
import { track, trackScreen } from "../analytics";
import { toggleMute } from "../sound";
import { currentUser, displayName } from "../firebase";

const BRAIN_EVERY = 3; // s — red AI thinks (solo only)
const INCOME_EVERY = 1; // s
const SNAP_EVERY = 0.1; // s — host → guest snapshots (legacy; unused under lockstep)

/* Deterministic lockstep (phases 1 & 3): a fixed sim tick + input delay. */
const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;
const TICK_DT = 1 / TICK_HZ; // s — every sim step integrates exactly this
/** Ticks between issuing an order and executing it. Both clients buffer orders
 *  to this shared tick, so they run in identical RNG order. ~200ms covers the
 *  relay round-trip; under worse latency the sim micro-stalls (never desyncs). */
const INPUT_DELAY = 12;
const MAX_STEPS_PER_UPDATE = 6; // anti-spiral: never simulate more than this per frame
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
  /** `?bot=1` — auto-play MY faction through the command path (desync tests). */
  private botMode = false;
  private botT = BRAIN_EVERY;

  /* Deterministic lockstep state */
  private simTick = 0; // ticks executed locally
  private remoteTick = 0; // highest tick the opponent has reached (from frames)
  private acc = 0; // ms accumulated toward the next fixed step
  private pendingCmds = new Map<number, CmdMsg[]>(); // executeTick → orders
  private outgoing: CmdMsg[] = []; // orders issued this tick, flushed in a frame
  private incomeT = INCOME_EVERY;
  private buckets: Target[][] = [];
  private sfxLast = new Map<string, number>();

  get myGold(): number {
    return this.gold[this.myFaction];
  }

  /** Flip-invariant gameplay signature for desync detection (host vs guest). */
  simSignature(): { tick: number; t: number; units: number; helis: number; buildings: number; goldR: number; goldB: number; share: number } {
    const units = this.units.filter((u) => !u.dead).length;
    const helis = this.helis.filter((h) => !h.dead).length;
    const buildings = this.buildings.filter((b) => !b.dead).length;
    return {
      tick: this.simTick, // exact sim tick — lets a comparer separate skew from drift
      t: Math.round(this.elapsed),
      units,
      helis,
      buildings,
      goldR: Math.floor(this.gold[RED]),
      goldB: Math.floor(this.gold[BLUE]),
      share: Math.round(this.blueShare * 100),
    };
  }

  /** Determinism probe: every unit (host space — identical on both clients now),
   *  sorted by nid, so the host and guest dumps can be diffed directly. */
  dumpUnits(): string {
    const rows = this.units
      .filter((u) => !u.dead)
      .map((u) => `${u.nid},${u.faction},${Math.round(u.cx)},${Math.round(u.cy)},${Math.round(u.hp)}`)
      .sort();
    return rows.join("|");
  }

  /** `?debug=1` overlay text — every comparable count, by ABSOLUTE faction
   *  (R/B), so the host and guest screenshots can be diffed number-for-number. */
  private debugReadout(): string {
    const u = this.units.filter((x) => !x.dead);
    const uR = u.filter((x) => x.faction === RED);
    const uB = u.filter((x) => x.faction === BLUE);
    const tk = (arr: Unit[]) => arr.filter((x) => x instanceof Tank).length;
    const h = this.helis.filter((x) => !x.dead);
    const b = this.buildings.filter((x) => !x.dead);
    const bR = b.filter((x) => x.faction === RED).length;
    const bB = b.filter((x) => x.faction === BLUE).length;
    const corr = this.role === "guest" ? `  corr ${(this.lastSnapBytes / 1024).toFixed(1)}KB` : "";
    return [
      `${this.role} t${Math.round(this.elapsed)}  share B ${Math.round(this.blueShare * 100)}%${corr}`,
      `units  R ${uR.length} (tk ${tk(uR)})  B ${uB.length} (tk ${tk(uB)})`,
      `heli   R ${h.filter((x) => x.faction === RED).length}  B ${h.filter((x) => x.faction === BLUE).length}`,
      `bldg   R ${bR}  B ${bB}`,
      `gold   R ${Math.floor(this.gold[RED])}  B ${Math.floor(this.gold[BLUE])}`,
      `lvl  s R${this.levels[RED]} B${this.levels[BLUE]}  tk R${this.tankLevels[RED]} B${this.tankLevels[BLUE]}  tu R${this.turretLevels[RED]} B${this.turretLevels[BLUE]}`,
    ].join("\n");
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
    this.simTick = 0;
    this.remoteTick = 0;
    this.acc = 0;
    this.pendingCmds.clear();
    this.outgoing = [];
    this.nextNid = 1;
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
    this.remote = null; // lockstep: the guest runs its own sim, no passive mirror
    if (this.role !== "solo") this.exchangeIpHash();

    this.map = new TileMap();
    this.board.addEntity(this.map);

    if (this.role === "guest") {
      // Lockstep: the guest builds the SAME initial state from the host's seed
      // (in setupInitialState, once `init` brings the map). Until then, wait.
      this.sendNet({ type: "ready", name: this.myName, uid: this.myUid });
    } else {
      this.setupInitialState();
    }

    this.hud = new Hud(this);
    this.board.addEntity(this.hud);
    this.topEntities = [this.hud];

    // ?debug=1 → on-screen FPS meter (to tell a CPU stall from snapshot jitter).
    this.fpsMeter = null;
    const qs = new URLSearchParams(window.location.search);
    this.debug = qs.get("debug") === "1";
    this.botMode = qs.get("bot") === "1";
    this.botT = BRAIN_EVERY;
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

  /**
   * Build the symmetric starting state. Both clients run this identically right
   * after seeding (same seed → same RNG draws in the same order), so their sims
   * start in lockstep. Identical host-space layout on every client (the guest
   * only flips its VIEW). MUST be the first srand-drawing call after seedSim,
   * with no random draws in between, or the sequences diverge.
   */
  private setupInitialState(): void {
    const mr = (row: number): number => row; // host space on every client
    this.placeBuilding(RED, "hq", 8, mr(2), true);
    this.placeBuilding(RED, "barracks", 4, mr(4), true);
    this.placeBuilding(RED, "barracks", 8, mr(4), true);
    this.placeBuilding(RED, "barracks", 12, mr(4), true);
    this.placeBuilding(RED, "turret", 6, mr(3), true);
    this.placeBuilding(RED, "turret", 10, mr(3), true);

    this.placeBuilding(BLUE, "hq", 8, mr(GRID_H - 3), true);
    this.placeBuilding(BLUE, "barracks", 4, mr(GRID_H - 5), true);
    this.placeBuilding(BLUE, "barracks", 8, mr(GRID_H - 5), true);
    this.placeBuilding(BLUE, "barracks", 12, mr(GRID_H - 5), true);
    this.placeBuilding(BLUE, "turret", 6, mr(GRID_H - 4), true);
    this.placeBuilding(BLUE, "turret", 10, mr(GRID_H - 4), true);

    for (let i = 0; i < 10; i++) {
      this.spawnSoldier(RED, srand(60, VIEW_W - 60), this.mirrorY(srand(5, 7) * TILE));
      this.spawnSoldier(BLUE, srand(60, VIEW_W - 60), this.mirrorY(srand(GRID_H - 7, GRID_H - 5) * TILE));
    }
    this.map.flushDirty();
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
   * Guest view mirror: the red player sees the island flipped vertically so
   * THEIR army sits at the bottom of the screen. The SIMULATION is identical
   * (host space) on every client; the mirror is applied ONLY at render (draw)
   * and input (handleTap). So float math is bit-symmetric → deterministic.
   * ------------------------------------------------------------------ */

  private get flipped(): boolean {
    return this.role === "guest";
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

    // Lockstep turn: advance our view of the opponent's tick (so we may step)
    // and buffer their orders to the shared execute tick. Flows both ways.
    if (data.type === "frame") {
      const fr = data as FrameMsg;
      if (fr.tick > this.remoteTick) this.remoteTick = fr.tick;
      if (fr.cmds && fr.cmds.length) {
        this.oppActed = true;
        const ex = fr.tick + INPUT_DELAY;
        const slot = this.pendingCmds.get(ex);
        if (slot) slot.push(...fr.cmds);
        else this.pendingCmds.set(ex, fr.cmds.slice());
      }
      return;
    }

    if (this.role === "host") {
      if (data.type === "ready") {
        if (typeof data.name === "string") this.enemyName = data.name || "Invite";
        if (typeof data.uid === "string") this.enemyUid = data.uid;
        // (Re)send the island + seed so the guest builds the SAME initial state.
        const init: InitMsg = { type: "init", map: this.map.getInitData(), name: this.myName, uid: this.myUid, matchId: this.matchId, seed: this.matchSeed };
        this.sendNet(init);
        this.sendNet({ type: "ip", hash: this.myIpHash ?? "" }); // (re)share our IP hash
      }
      return;
    }

    // Guest
    if (data.type === "init") {
      const initMsg = data as InitMsg;
      if (typeof initMsg.name === "string") this.enemyName = initMsg.name || "Invite";
      if (typeof initMsg.uid === "string") this.enemyUid = initMsg.uid;
      if (typeof initMsg.matchId === "string") this.matchId = initMsg.matchId;
      // First init only: seed, apply the map, then build the SAME initial state
      // as the host (lockstep). Re-sent inits (ready retries) are ignored.
      if (!this.inited) {
        if (typeof initMsg.seed === "number") this.matchSeed = initMsg.seed;
        seedSim(this.matchSeed);
        this.map.applyInit(initMsg.map); // host space on both — the guest flips only its view
        this.setupInitialState(); // first srand draw after seedSim — order matches host
        this.inited = true;
      }
      this.sendNet({ type: "ip", hash: this.myIpHash ?? "" }); // share our IP hash
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

  /**
   * Execute ONE order at its scheduled tick (lockstep) — mine or the opponent's,
   * identical on both clients. Orders travel in host space + an absolute faction;
   * each client converts coords to its own space (viewRow/viewY — identity on the
   * host, mirrored on the guest) and applies them to that faction.
   */
  private executeCommand(cmd: CmdMsg): void {
    if (this.ended) return;
    const f: Faction = cmd.faction === RED ? RED : BLUE;
    if (cmd.cmd === "axis" && typeof cmd.col === "number") {
      this.axisCol[f] = clamp(Math.round(cmd.col), 0, GRID_W - 1); // col is X — no mirror
      return;
    }
    if (cmd.cmd === "upgrade") {
      this.buyUpgrade(f, (cmd.kind === "tank" || cmd.kind === "turret" ? cmd.kind : "soldier") as UpgradeKind);
      return;
    }
    if (cmd.cmd === "strike" && typeof cmd.x === "number" && typeof cmd.y === "number") {
      if (this.gold[f] >= COST.strike) {
        this.gold[f] -= COST.strike;
        this.scheduleStrike(clamp(cmd.x, 0, VIEW_W), clamp(cmd.y, 0, MAP_H), f);
      }
      return;
    }
    if (cmd.cmd === "helico" && typeof cmd.x === "number") {
      if (this.gold[f] >= COST.helico) {
        this.gold[f] -= COST.helico;
        this.spawnHeli(f, clamp(cmd.x, 0, VIEW_W));
      }
      return;
    }
    if (
      cmd.cmd === "build" &&
      (cmd.kind === "barracks" || cmd.kind === "turret" || cmd.kind === "factory") &&
      typeof cmd.c === "number" &&
      typeof cmd.r === "number"
    ) {
      const c = cmd.c;
      const r = cmd.r; // host space on every client
      const cost = COST[cmd.kind];
      const i = this.map.idx(c, r);
      if (
        this.gold[f] >= cost &&
        this.map.isLand(c, r) &&
        this.map.owner[i] === f &&
        !this.buildingAt.has(i) &&
        !this.map.hasChest(i)
      ) {
        this.gold[f] -= cost;
        this.placeBuilding(f, cmd.kind, c, r);
        const center = this.map.tileCenter(c, r);
        this.spawnEffect(new Shockwave(center.x, center.y, 50, "#ffffff", 0.35));
        this.sfx("build", 0.5);
      }
    }
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

    // The map is rendered vertically flipped for the guest, so un-flip the tap
    // into host-space WORLD coords. The sim is identical on both clients, so the
    // command carries plain host-space coords (no per-client conversion).
    const wx = x;
    const wy = this.flipped ? MAP_H - y : y;

    // Orders are scheduled, not applied now: they execute at simTick+INPUT_DELAY
    // on BOTH clients (lockstep). The gold check here is just UX — the real
    // spend happens deterministically at execution (re-checked there).
    if (this.mode === "strike") {
      if (this.myGold < COST.strike) {
        this.board.playSound("error", false, 0.4);
        return;
      }
      this.mode = null;
      track("use_airstrike", { mode: this.role });
      this.queueCmd({ type: "cmd", faction: mine, cmd: "strike", x: Math.round(wx), y: Math.round(wy) });
      this.board.playSound("click", false, 0.5);
      return;
    }

    if (this.mode === "helico") {
      if (this.myGold < COST.helico) {
        this.board.playSound("error", false, 0.4);
        return;
      }
      this.mode = null;
      track("use_helico", { mode: this.role });
      this.queueCmd({ type: "cmd", faction: mine, cmd: "helico", x: Math.round(wx) });
      this.board.playSound("click", false, 0.5);
      return;
    }

    if (this.mode === "axis") {
      const c = clamp(Math.floor(wx / TILE), 0, GRID_W - 1);
      this.mode = null;
      track("set_axis", { mode: this.role });
      this.board.playSound("click", false, 0.5);
      this.spawnEffect(new ScorePopup(wx, wy, "AXE D'ATTAQUE", "#ffe27a", 16));
      this.queueCmd({ type: "cmd", faction: mine, cmd: "axis", col: c });
      return;
    }

    // Build
    const c = Math.floor(wx / TILE);
    const r = Math.floor(wy / TILE);
    const kind = this.mode;
    const cost = COST[kind];
    const i = this.map.idx(c, r);
    const occupied = this.buildingAt.has(i);
    const buildable = this.map.isLand(c, r) && this.map.owner[i] === mine && !occupied && !this.map.hasChest(i);
    if (!buildable) {
      this.board.playSound("error", false, 0.4);
      this.spawnEffect(new ScorePopup(wx, wy, "CASE INVALIDE", "#ff8b7a", 14));
      return;
    }
    if (this.myGold < cost) {
      this.board.playSound("error", false, 0.4);
      this.spawnEffect(new ScorePopup(wx, wy, "PAS ASSEZ D'OR", "#ff8b7a", 14));
      return;
    }
    this.mode = null;
    track("build", { type: kind, mode: this.role });
    this.board.playSound("build", false, 0.5);
    this.queueCmd({ type: "cmd", faction: mine, cmd: "build", kind, c, r });
  }

  /** Queue one of MY orders. It rides this tick's frame and executes at
   *  simTick+INPUT_DELAY on both clients. Counts as a meaningful action. */
  private queueCmd(cmd: CmdMsg): void {
    this.outgoing.push(cmd);
    this.myActs++;
  }

  private requestUpgrade(kind: UpgradeKind): void {
    const cost = this.upgradeCostFor(this.myFaction, kind);
    if (this.myGold < cost) {
      this.board.playSound("error", false, 0.4);
      return;
    }
    track("upgrade", { kind, level: this.upgradeLevelFor(this.myFaction, kind) + 1, mode: this.role });
    this.queueCmd({ type: "cmd", faction: this.myFaction, cmd: "upgrade", kind });
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
  /** Lockstep: the SIM is identical (host space) on every client now — the
   *  guest's mirror is applied at RENDER + INPUT only, so float math stays
   *  bit-symmetric. Always +1. (Kept as a method so entities need no change.) */
  flipY(): number {
    return 1;
  }

  /** Sim is host-space on both clients — no mirror in the simulation. */
  private mirrorY(y: number): number {
    return y;
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
          // Tie-break by nid: bucket scan order is mirror-flipped on the guest,
          // so on an exact-distance tie the two sims would otherwise pick
          // different targets and slowly desync. nid is mirror-invariant.
          if (d <= range && (d < bestD || (d === bestD && best !== null && t.nid < best.nid))) {
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
      if (d <= range && (d < bestD || (d === bestD && best !== null && h.nid < best.nid))) {
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

  /** Popup — each client spawns its own (the sim is deterministic). */
  private popup(x: number, y: number, text: string, colorIdx: 0 | 1): void {
    this.spawnEffect(new ScorePopup(x, y, text, colorIdx === 1 ? "#ff8b7a" : COLORS.gold, 15));
  }

  /* ---------------------------------------------------------------- *
   * Airstrikes (solo + host authoritative; guests get warn/boom events)
   * ---------------------------------------------------------------- */

  private scheduleStrike(x: number, y: number, f: Faction): void {
    this.strikes.push({ x, y, t: STRIKE_DELAY, faction: f });
    this.spawnEffect(new StrikeMarker(x, y, STRIKE_RADIUS, STRIKE_DELAY));
    this.popup(x, y - STRIKE_RADIUS - 8, "FRAPPE !", 1);
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
    // Real-time (not part of the deterministic sim): the join handshake retry
    // runs off wall-clock, before the sim even exists.
    if (this.role === "guest" && !this.inited) {
      this.readyT -= Math.min(delta, 50) / 1000;
      if (this.readyT <= 0) {
        this.readyT = 0.6;
        this.sendNet({ type: "ready", name: this.myName, uid: this.myUid });
      }
    }

    // Fixed-timestep sim (phase 1): accumulate wall-clock time and run whole
    // ticks of EXACTLY TICK_DT. The sim never reads `delta`, so it's identical
    // on every machine given the same inputs.
    if (this.inited && !this.ended) {
      this.acc += Math.min(delta, MAX_STEPS_PER_UPDATE * TICK_MS);
      let steps = 0;
      while (this.acc >= TICK_MS && steps < MAX_STEPS_PER_UPDATE) {
        // Lockstep stall (phase 3): don't execute a tick whose opponent orders
        // may not have arrived. Safe once the opponent reached simTick-DELAY.
        if (this.role !== "solo" && this.simTick > this.remoteTick + INPUT_DELAY) break;
        this.acc -= TICK_MS;
        this.simStep();
        steps++;
      }
    } else if (this.ended) {
      // Game over: the sim is frozen, but keep the engine ticking (real delta)
      // so step timers + the end-screen fader + cosmetics still run — otherwise
      // the post-match transition (addTimer → moveToStep "end") never fires.
      super.update(delta);
    }

    // Anti-AFK: void ONLY if the opponent never acts from the start (elapsed is
    // sim time). Going quiet mid-match after acting is legitimate.
    if (this.role !== "solo" && this.inited && !this.ended && !this.voided && !this.oppActed && this.elapsed > IDLE_LIMIT) {
      this.voidMatch("Adversaire inactif", true);
    }

    if (this.fpsMeter) this.fpsMeter.info = this.debugReadout();
    this.bringToFront();
  }

  /**
   * One deterministic simulation tick (fixed dt). Both clients run identical
   * ticks, apply each order at the same shared tick, and draw from one seeded
   * RNG in the same order → bit-exact state (mod the guest's vertical mirror).
   */
  private simStep(): void {
    const T = this.simTick;

    // 1. Execute orders scheduled for this tick. Each client issues only its
    //    OWN faction, so sorting by faction yields the same sequence on both.
    const due = this.pendingCmds.get(T);
    if (due) {
      this.pendingCmds.delete(T);
      due.sort((a, b) => a.faction - b.faction);
      for (const c of due) this.executeCommand(c);
    }

    // 2. Advance the world by exactly one tick.
    this.rebuildBuckets();
    for (const b of this.buildings) {
      b.soldierLevel = this.levels[b.faction];
      b.tankLevel = this.tankLevels[b.faction];
      b.turretLevel = this.turretLevels[b.faction];
    }
    super.update(TICK_MS); // every entity + timers, fixed dt
    this.updateStrikes(TICK_DT);

    this.incomeT -= TICK_DT;
    if (this.incomeT <= 0) {
      this.incomeT = INCOME_EVERY;
      this.gold[BLUE] += 2;
      // Solo: the AI's war chest grows with time — stall and it buries you
      this.gold[RED] += this.role === "solo" ? 2 + Math.min(2, (this.elapsed / 60) * 0.5) : 2;
    }

    if (this.role === "solo") {
      this.brainT -= TICK_DT;
      if (this.brainT <= 0) {
        this.brainT = BRAIN_EVERY;
        this.redBrain();
      }
      this.redPanic(TICK_DT);
    }

    // `?bot=1`: drive MY faction with the solo AI's reflexes through the command
    // path, so both clients play a real, escalating game (the lockstep test).
    if (this.botMode) {
      this.botT -= TICK_DT;
      if (this.botT <= 0) {
        this.botT = BRAIN_EVERY;
        this.playerBot();
      }
    }

    this.updateHqDefense(TICK_DT);
    this.blueShare = this.map.share(BLUE);
    this.updateHeliLoop(this.helis.some((h) => !h.dead));

    const mine = this.myFaction;
    const m = this.map.tileCenter(this.axisCol[mine], 0);
    // My front row (host space), then flipped to screen space for the guest —
    // the HUD draws this marker in screen space over the mirrored world.
    const wy = clamp(this.map.frontRowFromTop(mine, this.axisCol[mine]) * TILE, 60, MAP_H - 60);
    this.axisMarker = { x: m.x, y: this.flipped ? MAP_H - wy : wy };

    this.elapsed += TICK_DT;
    this.sweepDead();

    // 3. Publish this tick: buffer my orders to execute at T+DELAY on BOTH
    //    clients, and broadcast the turn (heartbeat even when there are none).
    const ex = T + (this.role === "solo" ? 1 : INPUT_DELAY);
    if (this.outgoing.length) {
      const slot = this.pendingCmds.get(ex);
      if (slot) slot.push(...this.outgoing);
      else this.pendingCmds.set(ex, this.outgoing.slice());
    }
    if (this.role !== "solo") this.sendNet({ type: "frame", tick: T, cmds: this.outgoing });
    this.outgoing = [];

    this.simTick = T + 1;
  }

  /**
   * Render the guest's world vertically MIRRORED (so their army sits at the
   * bottom) while the SIMULATION stays in host space. We swap each mobile
   * entity's cy → MAP_H-cy around the engine draw (sprites stay upright, their
   * local layout — health bars, shadows — is preserved) and flip the tilemap.
   * The HUD/faders are screen-space and untouched. This keeps the sim's float
   * math identical on both clients → bit-exact lockstep.
   */
  draw(): void {
    if (!this.flipped) {
      super.draw();
      return;
    }
    const world = [this.units, this.bullets, this.buildings, this.helis, this.effects];
    for (const list of world) for (const e of list) e.cy = MAP_H - e.cy;
    this.map.renderFlip = true;
    super.draw();
    this.map.renderFlip = false;
    for (const list of world) for (const e of list) e.cy = MAP_H - e.cy;
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
   * Test bot (`?bot=1`) — plays MY faction via the command path
   *
   * The mirror means that, on every screen, "my faction" sits at the
   * bottom and pushes upward, so one faction-generic brain works for the
   * host (blue) and the guest (red) alike. Decisions use Math.random/
   * randInt (NOT the sim RNG), so the bot's thinking never perturbs the
   * deterministic srand stream — only the orders it emits do, exactly as
   * a human tap would. Every order goes through bot* emitters that apply
   * locally AND broadcast, so both sims run the same escalating game.
   * ---------------------------------------------------------------- */

  private playerBot(): void {
    if (this.elapsed < AI_GRACE) return;
    const me = this.myFaction;
    const foe = enemyOf(me);
    const g = this.gold[me];
    const reserve = AI_MIN_RESERVE;

    // Keep the attack axis on the hottest column (free, like the solo AI).
    this.botAxis(this.contestedCol());

    const alive = this.buildings.filter((b) => !b.dead);
    const myB = (t: BuildingType) => alive.filter((b) => b.faction === me && b.type === t).length;
    const myUnits = this.units.filter((u) => !u.dead && u.faction === me).length;
    const foeUnits = this.units.filter((u) => !u.dead && u.faction === foe).length;

    // 1) Airstrike a dense enemy pack.
    if (g >= COST.strike + reserve) {
      const pack = this.densestPack(foe, 4);
      if (pack) {
        this.botStrike(pack.x, pack.y);
        return;
      }
    }
    // 2) Helico raid now and then, down a contested column.
    if (g >= COST.helico + reserve && Math.random() < 0.32) {
      this.botHeli(this.columnCenter(this.contestedCol()));
      return;
    }
    // 3) Upgrade to answer the current pressure.
    if (Math.random() < 0.4) {
      const kind: UpgradeKind = foeUnits > myUnits + 8 ? "turret" : Math.random() < 0.5 ? "soldier" : "tank";
      if (g >= this.upgradeCostFor(me, kind) + reserve) {
        this.botUpgrade(kind);
        return;
      }
    }
    // 4) Otherwise expand production / defense behind the front.
    const maxBarracks = Math.min(6, 4 + Math.floor(this.elapsed / 90));
    let want: "barracks" | "factory" | "turret" | null = null;
    if (foeUnits > myUnits + 10 && myB("turret") < 5 && g >= COST.turret + reserve) want = "turret";
    else if (myB("barracks") < maxBarracks && g >= COST.barracks + reserve * 0.4) want = "barracks";
    else if (myB("factory") < 2 && g >= COST.factory + reserve) want = "factory";
    else if (myB("turret") < 4 && g >= COST.turret + reserve) want = "turret";
    else if (g >= COST.barracks + reserve + 30) want = "barracks";
    if (want) this.botTryBuild(want);
  }

  /** Centre of mass of the densest cluster of `f`'s units (≥ minUnits within a strike radius). */
  private densestPack(f: Faction, minUnits: number): { x: number; y: number } | null {
    const us = this.units.filter((u) => !u.dead && u.faction === f);
    let best: { x: number; y: number } | null = null;
    let bestCount = minUnits;
    for (const u of us) {
      let count = 0;
      let sx = 0;
      let sy = 0;
      for (const o of us) {
        if (Math.hypot(o.cx - u.cx, o.cy - u.cy) <= STRIKE_RADIUS) {
          count++;
          sx += o.cx;
          sy += o.cy;
        }
      }
      if (count > bestCount) {
        bestCount = count;
        best = { x: sx / count, y: sy / count };
      }
    }
    return best;
  }

  /** The column where my front and the enemy's are closest — the live battle line. */
  private contestedCol(): number {
    const me = this.myFaction;
    const foe = enemyOf(me);
    let best = 8;
    let bestGap = Infinity;
    for (let c = 0; c < GRID_W; c++) {
      if (!this.map.isLand(c, 1) && !this.map.isLand(c, GRID_H - 2)) continue;
      const gap = this.map.frontRowFromTop(me, c) - this.map.frontRowFromTop(foe, c);
      if (gap < bestGap) {
        bestGap = gap;
        best = c;
      }
    }
    return clamp(best + randInt(-1, 1), 0, GRID_W - 1);
  }

  /** Find an owned, buildable tile just behind my front and raise `kind` there. */
  private botTryBuild(kind: "barracks" | "factory" | "turret"): void {
    const me = this.myFaction;
    const axis = this.axisCol[me];
    for (let tries = 0; tries < 20; tries++) {
      const c = clamp(axis + randInt(-4, 4), 0, GRID_W - 1);
      const front = this.map.frontRowFromTop(me, c); // smallest row I own (toward the enemy)
      const r = clamp(front + randInt(0, 3), 1, GRID_H - 2); // a touch behind it
      if (this.canBotBuildAt(me, c, r)) {
        this.botBuild(kind, c, r);
        return;
      }
    }
    // Fallback: spread out around my HQ so saved gold still becomes useful.
    const hq = this.buildings.find((b) => !b.dead && b.type === "hq" && b.faction === me);
    if (!hq) return;
    for (let tries = 0; tries < 12; tries++) {
      const c = clamp(hq.col + randInt(-4, 4), 0, GRID_W - 1);
      const r = clamp(hq.row + randInt(-5, -1), 1, GRID_H - 2); // toward the enemy = up = smaller row
      if (this.canBotBuildAt(me, c, r)) {
        this.botBuild(kind, c, r);
        return;
      }
    }
  }

  private canBotBuildAt(f: Faction, c: number, r: number): boolean {
    const i = this.map.idx(c, r);
    return this.map.isLand(c, r) && this.map.owner[i] === f && !this.buildingAt.has(i) && !this.map.hasChest(i);
  }

  /* Bot order emitters — queue exactly like a human tap (host space, scheduled
   * to execute at simTick+INPUT_DELAY on both clients). */
  private botBuild(kind: "barracks" | "factory" | "turret", c: number, r: number): void {
    this.queueCmd({ type: "cmd", faction: this.myFaction, cmd: "build", kind, c, r });
  }

  private botStrike(x: number, y: number): void {
    this.queueCmd({ type: "cmd", faction: this.myFaction, cmd: "strike", x: Math.round(x), y: Math.round(y) });
  }

  private botHeli(x: number): void {
    this.queueCmd({ type: "cmd", faction: this.myFaction, cmd: "helico", x: Math.round(x) });
  }

  private botAxis(c: number): void {
    if (this.axisCol[this.myFaction] === c) return;
    this.queueCmd({ type: "cmd", faction: this.myFaction, cmd: "axis", col: c });
  }

  private botUpgrade(kind: UpgradeKind): void {
    this.queueCmd({ type: "cmd", faction: this.myFaction, cmd: "upgrade", kind });
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

  /** Explosion — each client spawns its own (the sim is deterministic). */
  private explosion(x: number, y: number, big: boolean): void {
    this.explosionVisual(x, y, big);
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
    // Lockstep: the guest runs its own sim, so its local HQ kill can fire a
    // moment before (or, on drift, disagree with) the host. The host stays
    // authoritative for the verdict — the guest ends only via the "end" msg.
    if (this.role === "guest") return;
    if (this.role === "host") {
      // The guest's own sim destroys the HQ too; the host's verdict is final.
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
