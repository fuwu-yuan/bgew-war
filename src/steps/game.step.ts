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
  RED,
  TILE,
  VIEW_W,
  enemyOf,
  GAME_VERSION,
} from "../globals";
import { clamp, pick, rand, sha256, TAU } from "../utils";
import { seedSim, srand } from "../sim-rng";
import { BASE_GENOME, BattleView, Commander, GENE_BOUNDS, Genome, sanitizeGenome, SPEND } from "../commander";
import { BAL, buildCost, BuildKind, upgradeCost, UpgradeKind, UpgradeStat, UpLevels, UPGRADE_KINDS } from "../balance";
import { TileMap, type MapInitData } from "../entities/tilemap";
import type { RecordedCmd, SoloRecord } from "../solo-record";
import { Bullet, Soldier, Tank, Unit } from "../entities/units";
import { Building, BUILDING_CODE, BuildingType, turretMaxHp } from "../entities/buildings";
import { Helicopter } from "../entities/helicopter";
import { Fader, FpsMeter, Particle, ScorePopup, Shockwave, StrikeMarker, Tracer } from "../entities/effects";
import { BuildMode, Hud, HudState } from "../entities/hud";
import { GameObject } from "../entities/gameobject";
import { RemoteWorld } from "../entities/remote";
import { CmdMsg, EndMsg, FrameMsg, GameMsg, gameData, InitMsg, IpMsg, MultiData, SnapMsg, VoidMsg } from "../network";
import { track, trackScreen } from "../analytics";
import { toggleMute } from "../sound";
import { currentUser, displayName, recordSoloMatch } from "../firebase";
import { AI_TUNING, AiTuning, CLAUDE_DIFFICULTY, DIFFICULTIES, Difficulty, genomeFor } from "../ai";
import {
  askClaudeAdvice,
  ClaudeAdvice,
  ClaudeError,
  ClaudeJournalEntry,
  ClaudeReport,
  ClaudeSide,
  loadClaudePassword,
} from "../claude-general";

/** Niveaux d'amélioration d'un camp en début de partie. */
function freshUps(): Record<UpgradeKind, UpLevels> {
  const out = {} as Record<UpgradeKind, UpLevels>;
  for (const k of UPGRADE_KINDS) out[k] = { atk: 1, def: 1 };
  return out;
}

/** Bouton HUD « up:<branche>:<voie> » → branche + voie, sinon null. */
function parseUpgradeButton(id: string): { kind: UpgradeKind; stat: UpgradeStat } | null {
  const m = /^up:(soldier|tank|turret|heli):(atk|def)$/.exec(id);
  return m ? { kind: m[1] as UpgradeKind, stat: m[2] as UpgradeStat } : null;
}

const BOT_EVERY = 3; // s — the test bot (?bot=1) thinks
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
const SOLO_RECORD_MIN = 30; // s — en dessous, la partie n'apprend rien : pas d'envoi
const BOT_GRACE = 6; // s before the test bot (?bot=1) starts spending

/* Niveau CLAUDE — cadence du général-stratège (le commandant local, lui, joue en continu) */
const CLAUDE_FIRST_AT = 10; // s — premier rapport (le joueur a montré son ouverture)
const CLAUDE_EVERY = 20; // s entre la réponse du général et le rapport suivant
const CLAUDE_RETRY = 8; // s — après un échec réseau
const CLAUDE_JOURNAL_MAX = 5;
const TREND_EVERY = 10; // s — un point d'historique de territoire

type NetRole = "solo" | "host" | "guest";

/** Ce que le joueur a MONTRÉ (ses ordres exécutés, visibles à l'écran) — lu par le général Claude. */
interface PlayerHabits {
  strikes: number;
  helis: number;
  barracks: number;
  forwardBarracks: number;
  factories: number;
  turrets: number;
  upgrades: Record<string, number>;
  axisHist: number[];
  recent: string[];
}
function freshHabits(): PlayerHabits {
  return { strikes: 0, helis: 0, barracks: 0, forwardBarracks: 0, factories: 0, turrets: 0, upgrades: {}, axisHist: new Array<number>(GRID_W).fill(0), recent: [] };
}

/** Niveau CLAUDE : état du général distant (stratège). */
interface GeneralState {
  password: string;
  match: number; // jeton : ignore les réponses d'une partie précédente
  turn: number;
  inFlight: boolean;
  nextAt: number; // elapsed (s) du prochain rapport
  failures: number;
  /** Conseils reçus et appliqués depuis le début de la partie. */
  applied: number;
  journal: ClaudeJournalEntry[];
  current: ClaudeJournalEntry | null;
  latencyMs: number;
  lastError: string;
  lastChanges: string;
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
  private hqs: Record<Faction, Building | null> = { [RED]: null, [BLUE]: null };
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

  /* Airstrikes in flight */
  private strikes: { x: number; y: number; t: number; faction: Faction }[] = [];
  private hqLastHp: Record<Faction, number> = { [RED]: 0, [BLUE]: 0 };
  /** Rechargement de la frappe aérienne (s restantes), par camp — dans la sim (lockstep). */
  private strikeCd: Record<Faction, number> = { [RED]: 0, [BLUE]: 0 };
  private hqDefenseUsed: Record<Faction, number> = { [RED]: 0, [BLUE]: 0 }; // vagues de défense déjà levées

  /* HudState */
  public mode: BuildMode = null;
  public elapsed = 0;
  public blueShare = 0.5;
  public axisMarker: { x: number; y: number } | null = null;
  public myName = "Vous";
  public enemyName = "Adversaire";

  private gold: Record<Faction, number> = { [RED]: 0, [BLUE]: 0 };
  /** Améliorations de chaque camp : 4 branches × force/défense (1 = base). */
  private ups: Record<Faction, Record<UpgradeKind, UpLevels>> = { [RED]: freshUps(), [BLUE]: freshUps() };
  private killsBy: Record<Faction, number> = { [RED]: 0, [BLUE]: 0 };
  private axisCol: Record<Faction, number> = { [RED]: 8, [BLUE]: 8 };
  private counts = {
    [RED]: { soldiers: 0, tanks: 0 },
    [BLUE]: { soldiers: 0, tanks: 0 },
  };
  private ended = false;
  /** Post-match transition: ms left before the fade-out (−1 = inactive), plus
   *  the end-screen payload captured at showEnd. Driven by a real-time countdown
   *  in update() while the sim is frozen — see the `ended` branch. */
  private endTransitionT = -1;
  private endData: any = null;
  /** Solo : le commandant rouge (src/commander.ts) — il joue par le chemin de commandes. */
  private redCmd: Commander | null = null;
  private brainT = 0;
  /** Coupe l'IA rouge (banc d'essai : deux commandants pilotés de l'extérieur). */
  public aiOff = false;
  /** Enregistrement de la partie solo : graine + carte + tous les ordres exécutés
   *  (les deux camps). La sim étant déterministe, cela suffit à la rejouer. */
  private rec: { seed: number; map: MapInitData; cmds: RecordedCmd[] } | null = null;
  private recPhase: 0 | 1 = 0; // 0 = ordres planifiés du tick, 1 = ordres de l'IA (après l'avance du monde)
  /** Relecture : ordres de phase 1 à rejouer au même endroit du tick. */
  private replayAi: Map<number, CmdMsg[]> | null = null;
  /** Dernière partie solo enregistrée (lue par les outils de test). */
  public lastRecord: SoloRecord | null = null;
  /* Solo difficulty: every knob is a handicap or smarter play — never free gold. */
  private difficulty: Difficulty = "medium";
  private tun: AiTuning = AI_TUNING.medium;
  /** What the human has SHOWN so far (their executed, on-screen orders). */
  private habits: PlayerHabits = freshHabits();
  /** Historique de la part de territoire rouge (un point toutes les TREND_EVERY s). */
  private shareTrend: number[] = [];
  private trendT = TREND_EVERY;
  /** Niveau CLAUDE : le général (modèle distant) — null aux autres niveaux. */
  private general: GeneralState | null = null;
  /* HudState — réplique du général et témoin « réfléchit » */
  public enemySay = "";
  public enemySayAge = 0;
  public enemyThinking = false;
  /** `?bot=1` — auto-play MY faction through the command path (desync tests). */
  private botCmd: Commander | null = null;
  private botT = BOT_EVERY;

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
    const lv = (f: Faction, k: UpgradeKind): string => `${this.ups[f][k].atk}/${this.ups[f][k].def}`;
    return [
      `${this.role} t${Math.round(this.elapsed)}  share B ${Math.round(this.blueShare * 100)}%${corr}`,
      `units  R ${uR.length} (tk ${tk(uR)})  B ${uB.length} (tk ${tk(uB)})`,
      `heli   R ${h.filter((x) => x.faction === RED).length}  B ${h.filter((x) => x.faction === BLUE).length}`,
      `bldg   R ${bR}  B ${bB}`,
      `gold   R ${Math.floor(this.gold[RED])}  B ${Math.floor(this.gold[BLUE])}`,
      `lvl atk/def  s R${lv(RED, "soldier")} B${lv(BLUE, "soldier")}  tk R${lv(RED, "tank")} B${lv(BLUE, "tank")}  tu R${lv(RED, "turret")} B${lv(BLUE, "turret")}`,
      ...(this.general
        ? [
            `claude rapports ${this.general.turn}  conseils ${this.general.applied}  ${this.general.inFlight ? "pense" : "attend"}  ${this.general.latencyMs}ms  ko ${this.general.failures}`,
          ]
        : []),
    ].join("\n");
  }

  /** Ce qu'un commandant (IA locale, banc d'essai) peut lire de la bataille. */
  battleView(): BattleView {
    const self = this;
    return {
      get units() {
        return self.units;
      },
      strikeReady: (f: Faction) => self.strikeCd[f] <= 0,
      get buildings() {
        return self.buildings;
      },
      get helis() {
        return self.helis;
      },
      get map() {
        return self.map;
      },
      get elapsed() {
        return self.elapsed;
      },
      gold: (f) => self.gold[f],
      ups: (f) => self.ups[f],
      axis: (f) => self.axisCol[f],
      buildingAt: (i) => self.buildingAt.has(i),
      costOf: (f, kind) => self.costOf(f, kind),
    };
  }

  /** GameAPI : niveaux force/défense d'une branche. */
  upLevels(f: Faction, kind: UpgradeKind): UpLevels {
    return this.ups[f][kind];
  }

  /** HUD : mon niveau et le prix du suivant, par branche et par voie. */
  upLevel(kind: UpgradeKind, stat: UpgradeStat): number {
    return this.ups[this.myFaction][kind][stat];
  }
  upCost(kind: UpgradeKind, stat: UpgradeStat): number {
    return this.upgradeCostFor(this.myFaction, kind, stat);
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
    const upKey = parseUpgradeButton(id);
    if (upKey) {
      this.requestUpgrade(upKey.kind, upKey.stat);
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

  onEnter(data: { multi?: MultiData; difficulty?: Difficulty; replay?: SoloRecord }): void {
    this.role = data?.multi ? (data.multi.role === "guest" ? "guest" : "host") : "solo";
    this.myFaction = this.role === "guest" ? RED : BLUE;

    // Solo difficulty: from the menu, else `?diff=` (headless tests), else medium.
    const qsDiff = new URLSearchParams(window.location.search).get("diff") as Difficulty | null;
    this.difficulty = data?.difficulty ?? (qsDiff && DIFFICULTIES.includes(qsDiff) ? qsDiff : "medium");
    this.tun = AI_TUNING[this.difficulty];
    this.general =
      this.role === "solo" && this.difficulty === CLAUDE_DIFFICULTY
        ? {
            password: loadClaudePassword(),
            match: Date.now(),
            turn: 0,
            inFlight: false,
            nextAt: CLAUDE_FIRST_AT,
            failures: 0,
            applied: 0,
            journal: [],
            current: null,
            latencyMs: 0,
            lastError: "",
            lastChanges: "",
          }
        : null;
    this.enemySay = "";
    this.enemySayAge = 0;
    this.enemyThinking = false;

    // Player names shown in the HUD. Local name = signed-in pseudo, else a
    // sensible default. The enemy name arrives over the network (ready/init)
    // so it starts as a placeholder.
    const u = currentUser();
    this.myName = u && !u.isAnonymous ? displayName(u) : this.role === "solo" ? "Vous" : "Invite";
    this.enemyName =
      this.role === "solo" ? (this.general ? "CLAUDE" : `IA ${this.tun.label}`) : this.role === "guest" ? "Adversaire" : "Invite";
    // Ranked identity: my uid (empty when not signed in) and a shared match id
    // the host mints and shares so the Cloud Function can pair the two reports.
    this.myUid = u && !u.isAnonymous ? u.uid : "";
    this.enemyUid = "";
    this.matchId = this.role === "host" ? newMatchId() : "";
    this.matchSeed = this.role === "host" ? (Math.floor(Math.random() * 0xffffffff) >>> 0) : 0;
    // Seed the sim RNG now for the host/solo (which run the sim). The guest
    // reseeds when it receives the host's seed in `init`.
    const replay = this.role === "solo" ? data?.replay : undefined;
    const soloSeed = replay ? replay.seed >>> 0 : Math.floor(Math.random() * 0xffffffff) >>> 0;
    if (this.role !== "guest") seedSim(this.role === "solo" ? soloSeed : this.matchSeed);

    trackScreen("game");
    track("game_start", {
      mode: this.role,
      faction: this.myFaction === RED ? "red" : "blue",
      ...(this.role === "solo" ? { difficulty: this.difficulty } : {}),
    });

    this.units = [];
    this.bullets = [];
    this.buildings = [];
    this.helis = [];
    this.heliLoopOn = false;
    this.effects = [];
    this.buildingAt.clear();
    this.remote = null;
    // Fair play : l'or de départ de l'IA est un HANDICAP (≤ 80), jamais un bonus.
    // tun.startGold est exprimé sur la base historique de 80 : handicap proportionnel.
    this.gold = { [RED]: this.role === "solo" ? Math.round((this.tun.startGold / 80) * BAL.startGold) : BAL.startGold, [BLUE]: BAL.startGold };
    this.ups = { [RED]: freshUps(), [BLUE]: freshUps() };
    this.killsBy = { [RED]: 0, [BLUE]: 0 };
    this.mode = null;
    this.elapsed = 0;
    this.blueShare = 0.5;
    this.axisMarker = null;
    this.axisCol = { [RED]: 8, [BLUE]: 8 };
    this.counts = { [RED]: { soldiers: 0, tanks: 0 }, [BLUE]: { soldiers: 0, tanks: 0 } };
    this.ended = false;
    this.endTransitionT = -1;
    this.endData = null;
    this.brainT = this.tun.brainEvery;
    this.aiOff = false;
    // Solo : l'armée rouge est jouée par un commandant, avec la doctrine du niveau.
    this.redCmd =
      this.role === "solo" ? new Commander(this.battleView(), RED, genomeFor(this.tun), (c) => this.executeCommand(c)) : null;
    this.habits = freshHabits();
    this.shareTrend = [];
    this.trendT = TREND_EVERY;
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
    this.strikeCd = { [RED]: 0, [BLUE]: 0 };
    this.hqLastHp = { [RED]: 0, [BLUE]: 0 };
    this.hqDefenseUsed = { [RED]: 0, [BLUE]: 0 };
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
    // Relecture d'une partie enregistrée : même carte, IA coupée, ordres rejoués
    // aux mêmes ticks (et à la même phase du tick) que dans la partie d'origine.
    this.replayAi = null;
    this.rec = null;
    if (replay) {
      this.map.applyInit(replay.map);
      this.aiOff = true;
      this.general = null;
      this.replayAi = new Map();
      for (const rc of replay.cmds) {
        const { t, p, ...rest } = rc;
        const cmd = { type: "cmd", ...rest } as CmdMsg;
        const bucket = p === 1 ? this.replayAi : this.pendingCmds;
        const list = bucket.get(t);
        if (list) list.push(cmd);
        else bucket.set(t, [cmd]);
      }
    } else if (this.role === "solo") {
      this.rec = { seed: soloSeed, map: this.map.getInitData(), cmds: [] };
    }

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
    // `?bot=1` : MON camp est joué par un commandant (doctrine de base), par la file
    // d'ordres réseau comme un humain — c'est le test de désynchronisation.
    this.botCmd =
      qs.get("bot") === "1" ? new Commander(this.battleView(), this.myFaction, sanitizeGenome(BASE_GENOME), (c) => this.queueCmd(c)) : null;
    this.botT = BOT_EVERY;
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
    if (this.rec) {
      const { type: _type, ...rest } = cmd;
      this.rec.cmds.push({ ...rest, t: this.simTick, p: this.recPhase });
    }
    const f: Faction = cmd.faction === RED ? RED : BLUE;
    // Solo : le cerveau rouge étudie les ordres VISIBLES du joueur (adapt).
    if (this.role === "solo" && f === BLUE) this.observeBlue(cmd);
    if (cmd.cmd === "axis" && typeof cmd.col === "number") {
      this.axisCol[f] = clamp(Math.round(cmd.col), 0, GRID_W - 1); // col is X — no mirror
      return;
    }
    if (cmd.cmd === "upgrade") {
      const kind: UpgradeKind = cmd.kind === "tank" || cmd.kind === "turret" || cmd.kind === "heli" ? cmd.kind : "soldier";
      this.buyUpgrade(f, kind, cmd.stat === "def" ? "def" : "atk");
      return;
    }
    if (cmd.cmd === "strike" && typeof cmd.x === "number" && typeof cmd.y === "number") {
      if (this.gold[f] >= COST.strike && this.strikeCd[f] <= 0) {
        this.gold[f] -= COST.strike;
        this.strikeCd[f] = BAL.strike.cooldown;
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
      const cost = this.costOf(f, cmd.kind);
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
      const upBtn = parseUpgradeButton(btn);
      if (upBtn) {
        this.requestUpgrade(upBtn.kind, upBtn.stat);
        return;
      }
      this.board.playSound("click", false, 0.4);
      this.mode = this.mode === btn ? null : (btn as BuildMode);
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
      if (this.myGold < COST.strike || this.strikeWait > 0) {
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
    const cost = this.costOf(mine, kind);
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

  private requestUpgrade(kind: UpgradeKind, stat: UpgradeStat): void {
    const cost = this.upgradeCostFor(this.myFaction, kind, stat);
    if (this.myGold < cost) {
      this.board.playSound("error", false, 0.4);
      return;
    }
    track("upgrade", { kind, stat, level: this.ups[this.myFaction][kind][stat] + 1, mode: this.role });
    this.queueCmd({ type: "cmd", faction: this.myFaction, cmd: "upgrade", kind, stat });
  }

  /** Prix du prochain bâtiment de ce type pour ce camp (croît avec ceux qu'il possède). */
  costOf(f: Faction, kind: BuildKind): number {
    let owned = 0;
    for (const b of this.buildings) if (!b.dead && b.faction === f && b.type === kind) owned++;
    return buildCost(kind, owned);
  }

  /** HUD : prix affiché sur les boutons de construction du joueur. */
  buildCostOf(kind: BuildKind): number {
    return this.costOf(this.myFaction, kind);
  }

  private upgradeCostFor(f: Faction, kind: UpgradeKind, stat: UpgradeStat): number {
    return upgradeCost(kind, stat, this.ups[f][kind][stat]);
  }

  /** Paie et monte d'un niveau une voie (force/défense) d'une branche. */
  private buyUpgrade(f: Faction, kind: UpgradeKind, stat: UpgradeStat): void {
    const cost = this.upgradeCostFor(f, kind, stat);
    if (this.gold[f] < cost) return;
    this.gold[f] -= cost;
    const level = ++this.ups[f][kind][stat];
    // Défense des tourelles : les tourelles déjà posées gagnent les pv tout de suite.
    if (kind === "turret" && stat === "def") {
      const gain = turretMaxHp(level) - turretMaxHp(level - 1);
      for (const b of this.buildings) {
        if (b.dead || b.faction !== f || b.type !== "turret") continue;
        b.maxHp += gain;
        b.hp += gain;
      }
    }
    const hq = this.buildings.find((b) => !b.dead && b.type === "hq" && b.faction === f);
    const x = hq ? hq.cx : VIEW_W / 2;
    const y = hq ? hq.cy : MAP_H / 2;
    const label = kind === "tank" ? "TANKS" : kind === "turret" ? "TOURELLES" : kind === "heli" ? "HELICOS" : "SOLDATS";
    this.popup(x, y - 30, `${label} ${stat === "atk" ? "FORCE" : "DEFENSE"} ${level}`, 0);
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

  enemyHq(f: Faction): Building | null {
    const hq = this.hqs[enemyOf(f)];
    return hq && !hq.dead ? hq : null;
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

  fireBullet(x: number, y: number, target: Target, dmg: number, f: Faction, big: boolean, splash = 0): void {
    const b = new Bullet(this, x, y, target, dmg, f, big, splash);
    this.bullets.push(b);
    this.board.addEntity(b);
  }

  /** Dégâts de zone d'un obus (tank, QG) : unités ennemies au sol seulement —
   *  les bâtiments encaissent le tir direct, pas les éclats. */
  splashDamage(x: number, y: number, radius: number, dmg: number, f: Faction, except: Target): void {
    const c0 = Math.floor(x / TILE);
    const r0 = Math.floor(y / TILE);
    const span = Math.ceil(radius / TILE);
    for (let r = r0 - span; r <= r0 + span; r++) {
      if (r < 0 || r >= GRID_H) continue;
      for (let c = c0 - span; c <= c0 + span; c++) {
        if (c < 0 || c >= GRID_W) continue;
        const cell = this.buckets[r * GRID_W + c];
        if (!cell) continue;
        for (const t of cell) {
          if (t === except || t.dead || t.faction === f || !(t instanceof Unit)) continue;
          if (Math.hypot(t.cx - x, t.cy - y) > radius + t.radius) continue;
          t.hp -= dmg;
          if (t.hp <= 0) this.notifyKill(t, f);
        }
      }
    }
  }

  spawnSoldier(f: Faction, x: number, y: number): void {
    if (this.counts[f].soldiers >= BAL.maxSoldiers) return;
    this.counts[f].soldiers++;
    const u = new Soldier(this, f, x, y, this.ups[f].soldier.atk, this.ups[f].soldier.def);
    u.nid = this.nextNid++;
    this.units.push(u);
    this.board.addEntity(u);
  }

  spawnTank(f: Faction, x: number, y: number): void {
    if (this.counts[f].tanks >= BAL.maxTanks) return;
    this.counts[f].tanks++;
    const u = new Tank(this, f, x, y, this.ups[f].tank.atk, this.ups[f].tank.def);
    u.nid = this.nextNid++;
    this.units.push(u);
    this.board.addEntity(u);
  }

  /** Sortie d'hélico : décolle de la ligne arrière sur la colonne choisie. */
  spawnHeli(f: Faction, x: number): void {
    if (this.helis.filter((h) => !h.dead && h.faction === f).length >= BAL.heli.max) return;
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
    this.gold[f] += BAL.tileGold;
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
      this.gold[killer] += BAL.bounty.heli;
      this.killsBy[killer]++;
      return;
    }

    if (victim instanceof Unit) {
      const tank = victim instanceof Tank;
      this.counts[victim.faction][tank ? "tanks" : "soldiers"]--;
      this.explosion(victim.cx, victim.cy, tank);
      this.gold[killer] += tank ? BAL.bounty.tank : BAL.bounty.soldier;
      this.killsBy[killer]++;
      return;
    }

    // Building destroyed
    const b = victim as Building;
    this.buildingAt.delete(this.map.idx(b.col, b.row));
    this.explosion(b.cx, b.cy, true);
    this.board.playSound("explosion_big", false, 0.55);
    if (b.type !== "hq") this.gold[killer] += BAL.bounty[b.type];
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
    this.strikes.push({ x, y, t: BAL.strike.delay, faction: f });
    this.spawnEffect(new StrikeMarker(x, y, BAL.strike.radius, BAL.strike.delay));
    this.popup(x, y - BAL.strike.radius - 8, "FRAPPE !", 1);
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
    this.spawnEffect(new Shockwave(x, y, BAL.strike.radius * 2.2, "#ffffff", 0.6, 5));
    this.board.playSound("explosion_big", false, 0.6);

    for (const u of [...this.units]) {
      if (u.dead || u.distTo(x, y) > BAL.strike.radius + u.radius) continue;
      u.hp -= BAL.strike.dmgUnit;
      if (u.hp <= 0) this.notifyKill(u, u.faction === f ? enemyOf(f) : f);
    }
    for (const b of [...this.buildings]) {
      if (b.dead || b.distTo(x, y) > BAL.strike.radius + b.radius) continue;
      if (b.type === "hq") continue;
      b.hp -= BAL.strike.dmgBuilding;
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
    // on every machine given the same inputs. It keeps running AFTER the match
    // ends too, so the battle keeps raging (movement + explosions) behind the
    // end-screen fade — but ALWAYS at the fixed 60Hz tick, which runs sweepDead()
    // every step, so entities stay bounded. (The v1.7.1 freeze was this same
    // battle running off super.update() at REAL delta with NO sweep → the board
    // doubled every few frames until slower devices froze.)
    if (this.inited) {
      this.acc += Math.min(delta, MAX_STEPS_PER_UPDATE * TICK_MS);
      let steps = 0;
      while (this.acc >= TICK_MS && steps < MAX_STEPS_PER_UPDATE) {
        // Lockstep stall (phase 3): don't execute a tick whose opponent orders
        // may not have arrived. Only matters while the match is live and
        // deterministic — the post-verdict skirmish is cosmetic, so don't stall.
        if (!this.ended && this.role !== "solo" && this.simTick > this.remoteTick + INPUT_DELAY) break;
        this.acc -= TICK_MS;
        this.simStep();
        steps++;
      }
    }

    // Post-match: hold on the still-raging battle for a beat, then fade to the
    // end screen. A real-time countdown (NOT a step timer) so it's decoupled
    // from the sim cadence.
    if (this.ended && this.endTransitionT >= 0) {
      this.endTransitionT -= delta;
      if (this.endTransitionT <= 0) {
        this.endTransitionT = -1;
        const out = new Fader(0, 1, 700, "#08111f", () => this.board.moveToStep("end", this.endData));
        this.board.addEntity(out);
        this.topEntities.push(out);
      }
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
    this.recPhase = 0;
    const due = this.pendingCmds.get(T);
    if (due) {
      this.pendingCmds.delete(T);
      due.sort((a, b) => a.faction - b.faction);
      for (const c of due) this.executeCommand(c);
    }
    this.recPhase = 1;

    // 2. Advance the world by exactly one tick.
    this.rebuildBuckets();
    super.update(TICK_MS); // every entity + timers, fixed dt
    this.updateStrikes(TICK_DT);
    if (this.strikeCd[RED] > 0) this.strikeCd[RED] -= TICK_DT;
    if (this.strikeCd[BLUE] > 0) this.strikeCd[BLUE] -= TICK_DT;

    this.incomeT -= TICK_DT;
    if (this.incomeT <= 0) {
      this.incomeT = INCOME_EVERY;
      // Fair play : même revenu des deux côtés, à TOUS les niveaux — la
      // difficulté n'achète jamais d'or, elle achète de la réflexion.
      this.gold[BLUE] += BAL.income;
      this.gold[RED] += BAL.income;
    }

    const replayed = this.replayAi?.get(T);
    if (replayed) for (const c of replayed) this.executeCommand(c);
    if (this.role === "solo" && this.redCmd && !this.aiOff) {
      this.brainT -= TICK_DT;
      if (this.brainT <= 0) {
        this.brainT = this.tun.brainEvery;
        // Les handicaps des bas niveaux : délai de grâce et hésitations.
        if (this.elapsed >= this.tun.grace && Math.random() >= this.tun.skipChance) this.redCmd.think();
      }
      if (this.general) this.updateGeneral(TICK_DT);
    }

    // `?bot=1`: drive MY faction through the command path, so both clients
    // play a real, escalating game (the lockstep test).
    if (this.botCmd) {
      this.botT -= TICK_DT;
      if (this.botT <= 0) {
        this.botT = BOT_EVERY;
        if (this.elapsed >= BOT_GRACE) this.botCmd.think();
      }
    }

    this.updateSuddenDeath(TICK_DT);
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

  /** La mort subite est-elle en cours ? (HUD) */
  /** Secondes avant que MA frappe aérienne soit de nouveau disponible (0 = prête). */
  get strikeWait(): number {
    return Math.max(0, this.strikeCd[this.myFaction]);
  }

  get suddenDeath(): boolean {
    return !this.ended && this.elapsed >= BAL.suddenDeath.start;
  }

  /**
   * Mort subite : le QG du camp qui tient le moins de territoire s'effrite, de
   * plus en plus vite. Égalité parfaite = personne ne perd de pv.
   */
  private updateSuddenDeath(dt: number): void {
    const sd = BAL.suddenDeath;
    if (this.ended || this.elapsed < sd.start) return;
    if (this.elapsed - dt < sd.start) {
      this.popup(VIEW_W / 2, MAP_H / 2, "MORT SUBITE !", 1);
      this.board.playSound("explosion_big", false, 0.5);
    }
    const blue = this.map.share(BLUE);
    if (blue === 0.5) return;
    const loser: Faction = blue < 0.5 ? BLUE : RED;
    const hq = this.hqs[loser];
    if (!hq || hq.dead) return;
    hq.hp -= sd.dps * Math.pow(2, (this.elapsed - sd.start) / sd.doubleEvery) * dt;
    if (hq.hp <= 0) this.notifyKill(hq, enemyOf(loser));
  }

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

      // Paliers : 1re vague au premier coup, les suivantes à chaque tranche de pv perdue.
      const used = this.hqDefenseUsed[f];
      if (hq.hp < last && used < BAL.hqDefense.waves && hq.hp < hq.maxHp * (1 - used / BAL.hqDefense.waves)) {
        this.hqDefenseUsed[f] = used + 1;
        this.spawnHqDefenseWave(hq);
      }
      this.hqLastHp[f] = hq.hp;
    }
  }

  private spawnHqDefenseWave(hq: Building): void {
    const dir = (hq.faction === RED ? 1 : -1) * this.flipY();
    const enemy = enemyOf(hq.faction);
    const attackers = this.units.filter(
      (u) => !u.dead && u.faction === enemy && u.distTo(hq.cx, hq.cy) <= BAL.hqDefense.radius
    );
    const nearest = attackers.sort((a, b) => a.distTo(hq.cx, hq.cy) - b.distTo(hq.cx, hq.cy))[0];
    if (nearest) this.axisCol[hq.faction] = clamp(Math.floor(nearest.cx / TILE), 0, GRID_W - 1);

    const attackersPower = attackers.reduce((sum, u) => sum + (u instanceof Tank ? 3 : 1), 0);
    const soldiers = clamp(
      Math.round(BAL.hqDefense.minSoldiers + attackersPower * 0.45),
      BAL.hqDefense.minSoldiers,
      BAL.hqDefense.maxSoldiers
    );
    const tanks = clamp(
      Math.round(BAL.hqDefense.minTanks + attackersPower / 18),
      BAL.hqDefense.minTanks,
      BAL.hqDefense.maxTanks
    );

    for (let i = 0; i < soldiers; i++) {
      const spread = i % 2 === 0 ? -1 : 1;
      this.spawnSoldier(
        hq.faction,
        hq.cx + spread * srand(18, 150),
        hq.cy + dir * srand(35, 165)
      );
    }
    for (let i = 0; i < tanks; i++) {
      this.spawnTank(hq.faction, hq.cx + srand(-130, 130), hq.cy + dir * srand(55, 150));
    }
    this.popup(hq.cx, hq.cy - 54, `DEFENSE QG +${soldiers}`, hq.faction === RED ? 1 : 0);
    this.spawnEffect(new Shockwave(hq.cx, hq.cy, 150, "#ffffff", 0.55));
    this.sfx("build", 0.5);
  }

  /* ---------------------------------------------------------------- *
   * Solo : ce que le joueur montre, et le général Claude (stratège)
   *
   * L'armée rouge est jouée par un Commander (src/commander.ts) à tous les
   * niveaux. Au niveau CLAUDE, un modèle distant reçoit un rapport toutes
   * les ~20 s et renvoie une doctrine que le commandant applique aussitôt.
   * Le commandant n'attend jamais le général : si celui-ci est lent ou
   * injoignable, la partie continue avec la doctrine courante.
   * ---------------------------------------------------------------- */

  /** Le joueur vient de donner un ordre visible : on le note (lu par le général). */
  private observeBlue(cmd: CmdMsg): void {
    const h = this.habits;
    const t = Math.round(this.elapsed);
    let note = "";
    if (cmd.cmd === "strike" && typeof cmd.x === "number" && typeof cmd.y === "number") {
      h.strikes++;
      note = `frappe (${Math.floor(cmd.x / TILE)},${Math.floor(cmd.y / TILE)})`;
    } else if (cmd.cmd === "helico" && typeof cmd.x === "number") {
      h.helis++;
      note = `helico col ${Math.floor(cmd.x / TILE)}`;
    } else if (cmd.cmd === "upgrade") {
      const key = `${cmd.kind ?? "soldier"}${cmd.stat === "def" ? "Def" : "Atk"}`;
      h.upgrades[key] = (h.upgrades[key] ?? 0) + 1;
      note = `amelioration ${key}`;
    } else if (cmd.cmd === "axis" && typeof cmd.col === "number") {
      h.axisHist[clamp(Math.round(cmd.col), 0, GRID_W - 1)] += 1;
      note = `axe col ${Math.round(cmd.col)}`;
    } else if (cmd.cmd === "build" && typeof cmd.c === "number" && typeof cmd.r === "number") {
      if (cmd.kind === "barracks") {
        h.barracks++;
        // « avancée » : à 2 rangées ou moins de son front dans cette colonne
        if (cmd.r - this.map.blueFrontRow(cmd.c) <= 2) h.forwardBarracks++;
      } else if (cmd.kind === "factory") h.factories++;
      else if (cmd.kind === "turret") h.turrets++;
      note = `${cmd.kind} (${cmd.c},${cmd.r})`;
    }
    if (note) {
      h.recent.push(`t=${t} ${note}`);
      if (h.recent.length > 20) h.recent.shift();
    }
  }

  private updateGeneral(dt: number): void {
    const g = this.general;
    if (!g) return;
    this.enemySayAge += dt;
    this.enemyThinking = g.inFlight;
    this.trendT -= dt;
    if (this.trendT <= 0) {
      this.trendT = TREND_EVERY;
      this.shareTrend.push(this.map.share(RED));
      if (this.shareTrend.length > 12) this.shareTrend.shift();
    }
    if (!g.inFlight && !this.ended && this.elapsed >= g.nextAt) this.requestGeneralAdvice();
  }

  private requestGeneralAdvice(): void {
    const g = this.general;
    if (!g || g.inFlight || !this.redCmd) return;
    g.inFlight = true;
    g.turn++;
    const match = g.match;
    askClaudeAdvice(g.password, this.claudeReport(g), g.journal)
      .then((res) => {
        if (this.general !== g || g.match !== match || this.board.step !== this) return;
        g.inFlight = false;
        g.failures = 0;
        g.latencyMs = res.latencyMs;
        g.nextAt = this.elapsed + CLAUDE_EVERY;
        if (!this.ended) this.applyAdvice(res.advice);
        this.publishGeneralDebug();
      })
      .catch((e: ClaudeError) => {
        if (this.general !== g || g.match !== match) return;
        g.inFlight = false;
        g.failures++;
        g.lastError = `${e.code}: ${e.message}`;
        // mot de passe refusé : inutile d'insister, le commandant finit la partie seul
        g.nextAt = e.code === "password" ? Infinity : this.elapsed + CLAUDE_RETRY;
        if (g.failures === 1 || e.code === "password") console.warn("[claude] général injoignable —", g.lastError);
        this.publishGeneralDebug();
      });
    this.publishGeneralDebug();
  }

  /** Un camp vu de l'écran : bâtiments, unités, niveaux. */
  private claudeSide(f: Faction): ClaudeSide {
    const side: ClaudeSide = { barracks: 0, factories: 0, turrets: 0, frontTurrets: 0, soldiers: 0, tanks: 0, helis: 0, ups: this.ups[f] };
    for (const b of this.buildings) {
      if (b.dead || b.faction !== f) continue;
      if (b.type === "barracks") side.barracks++;
      else if (b.type === "factory") side.factories++;
      else if (b.type === "turret") {
        side.turrets++;
        // hors de la base : une tourelle qu'un hélico adverse croisera
        const edge = f === RED ? b.cy : MAP_H - b.cy;
        if (edge >= BAL.heli.turnBack - BAL.turret.range) side.frontTurrets++;
      }
    }
    side.soldiers = this.counts[f].soldiers;
    side.tanks = this.counts[f].tanks;
    side.helis = this.helis.filter((h) => !h.dead && h.faction === f).length;
    return side;
  }

  /** Le rapport de bataille : strictement ce qui est visible à l'écran, plus l'or ROUGE. */
  private claudeReport(g: GeneralState): ClaudeReport {
    const h = this.habits;
    let favoredCol = -1;
    let best = 0.75;
    for (let c = 0; c < GRID_W; c++) {
      if (h.axisHist[c] > best) {
        best = h.axisHist[c];
        favoredCol = c;
      }
      h.axisHist[c] *= 0.8; // les vieilles habitudes s'estompent
    }
    const hp = (f: Faction): number => {
      const hq = this.hqs[f];
      return hq && !hq.dead ? clamp(hq.hp / hq.maxHp, 0, 1) : 0;
    };
    return {
      turn: g.turn,
      t: this.elapsed,
      share: this.map.share(RED),
      trend: this.shareTrend.slice(-8),
      gold: this.gold[RED],
      suddenDeathIn: BAL.suddenDeath.start - this.elapsed,
      hq: { red: hp(RED), blue: hp(BLUE) },
      me: this.claudeSide(RED),
      foe: this.claudeSide(BLUE),
      habits: {
        strikes: h.strikes,
        helis: h.helis,
        barracks: h.barracks,
        forwardBarracks: h.forwardBarracks,
        factories: h.factories,
        turrets: h.turrets,
        upgrades: { ...h.upgrades },
        favoredCol,
        recent: h.recent.slice(-12),
      },
      spent: { ...this.redCmd!.spent },
      doctrine: this.redCmd!.genome,
    };
  }

  /** Applique la doctrine reçue : fusionnée sur la doctrine courante, puis bornée. */
  private applyAdvice(advice: ClaudeAdvice): void {
    const g = this.general;
    const cmd = this.redCmd;
    if (!g || !cmd) return;
    // Clôture du journal du conseil précédent : ce qu'il a donné.
    if (g.current) {
      g.current.shareAfter = this.map.share(RED);
      g.journal.push(g.current);
      if (g.journal.length > CLAUDE_JOURNAL_MAX) g.journal.splice(0, g.journal.length - CLAUDE_JOURNAL_MAX);
    }
    const old = cmd.genome;
    const d = advice.doctrine ?? {};
    const merged: Genome = { ...old, w: { ...old.w } };
    for (const k of SPEND) {
      const v = d.w?.[k];
      if (typeof v === "number") merged.w[k] = v;
    }
    for (const k of Object.keys(GENE_BOUNDS) as (keyof typeof GENE_BOUNDS)[]) {
      const v = d[k];
      if (typeof v === "number") merged[k] = v;
    }
    const next = sanitizeGenome(merged, old);
    // Résumé des vrais changements (≥ 15 %) pour le journal et le debug.
    const changes: string[] = [];
    const diff = (label: string, a: number, b: number): void => {
      if (Math.abs(a - b) > Math.max(0.05, Math.abs(a) * 0.15)) changes.push(`${label} ${+a.toFixed(2)}→${+b.toFixed(2)}`);
    };
    for (const k of SPEND) diff(k, old.w[k], next.w[k]);
    for (const k of Object.keys(GENE_BOUNDS) as (keyof typeof GENE_BOUNDS)[]) diff(k, old[k], next[k]);
    cmd.genome = next;
    g.applied++;
    g.lastChanges = changes.join(", ") || "aucun";
    g.current = {
      t: this.elapsed,
      analyse: advice.analyse,
      changes: g.lastChanges,
      shareBefore: this.map.share(RED),
      shareAfter: 0,
    };
    if (advice.message) {
      this.enemySay = advice.message;
      this.enemySayAge = 0;
    }
  }

  /** Expose l'état du général aux tests headless (aucun secret). */
  private publishGeneralDebug(): void {
    const g = this.general;
    const w = window as unknown as { __bgewClaude?: unknown };
    if (!g) {
      delete w.__bgewClaude;
      return;
    }
    w.__bgewClaude = {
      turn: g.turn,
      applied: g.applied,
      failures: g.failures,
      inFlight: g.inFlight,
      latencyMs: g.latencyMs,
      lastError: g.lastError,
      lastChanges: g.lastChanges,
      journal: g.journal,
      say: this.enemySay,
      doctrine: this.redCmd?.genome ?? null,
      spent: this.redCmd?.spent ?? null,
    };
  }

  /* ---------------------------------------------------------------- *
   * World helpers
   * ---------------------------------------------------------------- */

  private placeBuilding(f: Faction, type: BuildingType, c: number, r: number, instant = false): void {
    const b = new Building(this, f, type, c, r, instant);
    b.nid = this.nextNid++;
    if (type === "hq") this.hqs[f] = b;
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

    // Partie solo terminée : on garde de quoi la rejouer (apprentissage du bot).
    if (this.rec) {
      const record: SoloRecord = {
        version: GAME_VERSION,
        difficulty: this.difficulty,
        seed: this.rec.seed,
        map: this.rec.map,
        cmds: this.rec.cmds,
        bal: JSON.stringify(BAL),
        ticks: this.simTick + 1, // le tick en cours compte
        time: Math.round(time),
        win,
        share: +blueShare.toFixed(3),
      };
      this.rec = null;
      this.lastRecord = record;
      // ni le banc d'essai (IA coupée) ni le bot de test n'alimentent l'historique
      if (!this.aiOff && !this.botCmd && time >= SOLO_RECORD_MIN) void recordSoloMatch(record);
    }

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
    // Hold on the frozen battle for a beat, then fade to the end screen. The
    // countdown is driven by update()'s `ended` branch (NOT a step timer), so it
    // ticks even though the sim is frozen and no super.update() runs the timers.
    this.endData = data;
    this.endTransitionT = this.voided ? 1200 : 2200;
  }
}
