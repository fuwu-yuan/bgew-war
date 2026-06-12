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
  upgradeCost,
} from "../globals";
import { clamp, pick, rand, randInt, TAU } from "../utils";
import { flipMapData, flipTileIndex, TileMap } from "../entities/tilemap";
import { Bullet, Soldier, Tank, Unit } from "../entities/units";
import { Building, BUILDING_CODE, BuildingType } from "../entities/buildings";
import { Fader, Particle, ScorePopup, Shockwave, StrikeMarker, Tracer } from "../entities/effects";
import { BuildMode, Hud, HudState } from "../entities/hud";
import { GameObject } from "../entities/gameobject";
import { RemoteWorld } from "../entities/remote";
import { CmdMsg, EndMsg, GameMsg, gameData, InitMsg, MultiData, SnapMsg } from "../network";

const BRAIN_EVERY = 3; // s — red AI thinks (solo only)
const INCOME_EVERY = 1; // s
const SNAP_EVERY = 0.1; // s — host → guest snapshots
const AI_GRACE = 6; // s before the AI starts spending
const GARRISON_COST = 50;
const GARRISON_CD = 8; // s
const HQ_ALERT_RADIUS = 240; // px — enemies this close to the HQ trigger panic

type NetRole = "solo" | "host" | "guest";

export class PlayStep extends GameStep implements GameAPI, HudState {
  name = "game";

  public map!: TileMap;
  private hud!: Hud;
  private remote: RemoteWorld | null = null;
  private units: Unit[] = [];
  private bullets: Bullet[] = [];
  private buildings: Building[] = [];
  private effects: GameObject[] = [];
  private buildingAt = new Map<number, Building>();
  private topEntities: Entity[] = [];

  /* Multiplayer */
  private role: NetRole = "solo";
  public myFaction: Faction = BLUE;
  private inited = true; // guest: received init from host
  private readyT = 0;
  private snapT = 0;
  private nextNid = 1;
  private pShots: number[][] = [];
  private pBooms: number[][] = [];
  private pPops: [number, number, string, number][] = [];
  private pWarns: number[][] = [];

  /* Airstrikes in flight + solo-AI panic state */
  private strikes: { x: number; y: number; t: number; faction: Faction }[] = [];
  private garrisonCd = 0;
  private alertT = 0;

  /* HudState */
  public mode: BuildMode = null;
  public elapsed = 0;
  public blueShare = 0.5;
  public axisMarker: { x: number; y: number } | null = null;

  private gold: Record<Faction, number> = { [RED]: 0, [BLUE]: 0 };
  private levels: Record<Faction, number> = { [RED]: 1, [BLUE]: 1 };
  private killsBy: Record<Faction, number> = { [RED]: 0, [BLUE]: 0 };
  private axisCol: Record<Faction, number> = { [RED]: 8, [BLUE]: 8 };
  private counts = {
    [RED]: { soldiers: 0, tanks: 0 },
    [BLUE]: { soldiers: 0, tanks: 0 },
  };
  private ended = false;
  private brainT = BRAIN_EVERY;
  private incomeT = INCOME_EVERY;
  private buckets: Target[][] = [];
  private sfxLast = new Map<string, number>();

  get myGold(): number {
    return this.gold[this.myFaction];
  }

  get soldierLevel(): number {
    return this.levels[this.myFaction];
  }

  get soldierUpgradeCost(): number | null {
    return upgradeCost(this.levels[this.myFaction]);
  }

  constructor(board: Board) {
    super(board);
    board.onMouseEvent("click", (_e: MouseEvent, x: number, y: number) => {
      if (board.step !== this || this.ended) return;
      this.handleTap(x, y);
    });
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  onEnter(data: { multi?: MultiData }): void {
    this.role = data?.multi ? (data.multi.role === "guest" ? "guest" : "host") : "solo";
    this.myFaction = this.role === "guest" ? RED : BLUE;

    this.units = [];
    this.bullets = [];
    this.buildings = [];
    this.effects = [];
    this.buildingAt.clear();
    this.remote = null;
    this.gold = { [RED]: this.role === "solo" ? 40 : 80, [BLUE]: 80 };
    this.levels = { [RED]: 1, [BLUE]: 1 };
    this.killsBy = { [RED]: 0, [BLUE]: 0 };
    this.mode = null;
    this.elapsed = 0;
    this.blueShare = 0.5;
    this.axisMarker = null;
    this.axisCol = { [RED]: 8, [BLUE]: 8 };
    this.counts = { [RED]: { soldiers: 0, tanks: 0 }, [BLUE]: { soldiers: 0, tanks: 0 } };
    this.ended = false;
    this.brainT = BRAIN_EVERY;
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
    this.inited = this.role !== "guest";
    this.sfxLast.clear();
    this.camera.x = 0;
    this.camera.y = 0;

    this.map = new TileMap();
    this.board.addEntity(this.map);

    if (this.role === "guest") {
      // Passive mirror: the island and every unit come from the host
      this.remote = new RemoteWorld();
      this.board.addEntity(this.remote);
      this.sendNet({ type: "ready" });
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
        this.spawnSoldier(RED, rand(60, VIEW_W - 60), rand(5, 7) * TILE);
        this.spawnSoldier(BLUE, rand(60, VIEW_W - 60), rand(GRID_H - 7, GRID_H - 5) * TILE);
      }
      // Initial claims are already part of the init payload the guest gets
      this.map.flushDirty();
    }

    this.hud = new Hud(this);
    this.board.addEntity(this.hud);
    this.topEntities = [this.hud];

    const fadeIn = new Fader(1, 0, 500);
    this.board.addEntity(fadeIn);
    this.topEntities.push(fadeIn);

    this.board.playSound("music_battle", true, 0.3);
  }

  onLeave(): void {
    this.board.stopSound("music_battle", true, 600);
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

    if (this.role === "host") {
      if (data.type === "ready") {
        // (Re)send the island + an immediate snapshot
        const init: InitMsg = { type: "init", map: this.map.getInitData() };
        this.sendNet(init);
        this.sendSnapshot();
      } else if (data.type === "cmd") {
        this.applyCommand(data as CmdMsg);
      }
      return;
    }

    // Guest
    if (data.type === "init") {
      const init = (data as InitMsg).map;
      this.map.applyInit(this.flipped ? flipMapData(init) : init);
      this.inited = true;
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

  private opponentGone(reason: string): void {
    if (this.role === "solo" || this.ended) return;
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
      this.buyUpgrade(RED);
      return;
    }
    if (cmd.cmd === "strike" && typeof cmd.x === "number" && typeof cmd.y === "number") {
      if (this.gold[RED] >= COST.strike) {
        this.gold[RED] -= COST.strike;
        this.scheduleStrike(clamp(cmd.x, 0, VIEW_W), clamp(cmd.y, 0, MAP_H), RED);
      }
      return;
    }
    if (cmd.cmd === "build" && cmd.kind && typeof cmd.c === "number" && typeof cmd.r === "number") {
      const cost = COST[cmd.kind];
      const i = this.map.idx(cmd.c, cmd.r);
      if (
        this.gold[RED] >= cost &&
        this.map.isLand(cmd.c, cmd.r) &&
        this.map.owner[i] === RED &&
        !this.buildingAt.has(i) &&
        !this.map.hasDecor(i)
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
  private sendSnapshot(): void {
    const snap: SnapMsg = {
      type: "snap",
      units: this.units
        .filter((u) => !u.dead)
        .map((u) => [
          u.nid,
          u instanceof Tank ? 1 : 0,
          u.faction,
          Math.round(u.cx),
          Math.round(u.cy),
          Math.ceil(u.hp),
          u.maxHp,
          u.level,
        ]),
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
      lvl: { red: this.levels[RED], blue: this.levels[BLUE] },
      share: this.map.share(BLUE),
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
    this.remote.applySnapshot(
      snap.units.map(([nid, kind, f, x, y, hp, maxHp, level]) => [nid, kind, f, x, this.viewY(y), hp, maxHp, level]),
      snap.buildings.map(([nid, t, f, c, r, hp, maxHp, prog]) => [nid, t, f, c, this.viewRow(r), hp, maxHp, prog])
    );
    for (const [i, owner] of snap.own) {
      this.map.setOwner(this.viewIdx(i), owner);
    }
    if (snap.own.length > 0) this.sfx("capture", 0.16);
    for (const [x, y, tx, ty, big] of snap.shots) {
      this.spawnEffect(new Tracer(x, this.viewY(y), tx, this.viewY(ty), big === 1));
      this.sfx(big === 1 ? "tankshot" : `shot${1 + (Math.abs(x + y) % 3)}`, big === 1 ? 0.2 : 0.12);
    }
    for (const [x, y, big] of snap.booms) {
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
    this.blueShare = snap.share;
  }

  /* ---------------------------------------------------------------- *
   * Input — one tap handler drives everything (desktop & mobile)
   * ---------------------------------------------------------------- */

  private handleTap(x: number, y: number): void {
    const mine = this.myFaction;

    if (y >= MAP_H) {
      const btn = this.hud.hitButton(x, y);
      if (!btn) return;
      if (btn === "upgrade") {
        this.requestUpgrade();
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

    if (this.mode === "axis") {
      const c = clamp(Math.floor(x / TILE), 0, GRID_W - 1);
      this.axisCol[mine] = c;
      this.mode = null;
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
    const buildable = this.map.isLand(c, r) && this.map.owner[i] === mine && !occupied && !this.map.hasDecor(i);
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

  private requestUpgrade(): void {
    const cost = this.soldierUpgradeCost;
    if (cost === null || this.myGold < cost) {
      this.board.playSound("error", false, 0.4);
      return;
    }
    if (this.role === "guest") {
      this.sendNet({ type: "cmd", cmd: "upgrade" });
      this.board.playSound("build", false, 0.5);
      return;
    }
    this.buyUpgrade(this.myFaction);
  }

  /** Solo/host: pay and raise a faction's soldier level. */
  private buyUpgrade(f: Faction): void {
    const cost = upgradeCost(this.levels[f]);
    if (cost === null || this.gold[f] < cost) return;
    this.gold[f] -= cost;
    this.levels[f]++;
    const hq = this.buildings.find((b) => !b.dead && b.type === "hq" && b.faction === f);
    const x = hq ? hq.cx : VIEW_W / 2;
    const y = hq ? hq.cy : MAP_H / 2;
    this.popup(x, y - 30, `SOLDATS NIVEAU ${this.levels[f]}`, 0);
    this.spawnEffect(new Shockwave(x, y, 70, COLORS.gold, 0.45));
    this.sfx("coin", 0.5);
  }

  /* ---------------------------------------------------------------- *
   * GameAPI
   * ---------------------------------------------------------------- */

  axisX(f: Faction): number {
    return this.axisCol[f] * TILE + TILE / 2;
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

  spawnTank(f: Faction, x: number, y: number): void {
    if (this.counts[f].tanks >= MAX_TANKS) return;
    this.counts[f].tanks++;
    const u = new Tank(this, f, x, y);
    u.nid = this.nextNid++;
    this.units.push(u);
    this.board.addEntity(u);
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
      // Barracks spawn at their faction's current level
      for (const b of this.buildings) b.soldierLevel = this.levels[b.faction];
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

        this.blueShare = this.map.share(BLUE);
      }

      if (this.role === "host") {
        this.snapT -= dt;
        if (this.snapT <= 0) {
          this.snapT = SNAP_EVERY;
          this.sendSnapshot();
        }
      }

      if (this.role === "guest" && !this.inited) {
        this.readyT -= dt;
        if (this.readyT <= 0) {
          this.readyT = 0.6;
          this.sendNet({ type: "ready" });
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

    this.sweepDead();
    this.bringToFront();
  }

  /* ---------------------------------------------------------------- *
   * Red AI (solo only)
   * ---------------------------------------------------------------- */

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
        if (this.map.isLand(c, r) && this.map.owner[i] === RED && !this.buildingAt.has(i) && !this.map.hasDecor(i)) {
          this.gold[RED] -= COST.turret;
          this.placeBuilding(RED, "turret", c, r);
          break;
        }
      }
    }
  }

  private redBrain(): void {
    // Aim where it hurts: the column where blue pushed deepest — or, when
    // red dominates, the weakest blue column to finish the job.
    let deepest = 8;
    let deepestRow = GRID_H;
    let weakest = 8;
    let weakestRow = 0;
    for (let c = 0; c < GRID_W; c++) {
      if (!this.map.isLand(c, 1) && !this.map.isLand(c, GRID_H - 2)) continue;
      const fr = this.map.blueFrontRow(c);
      if (fr < deepestRow) {
        deepestRow = fr;
        deepest = c;
      }
      if (fr > weakestRow && fr < GRID_H) {
        weakestRow = fr;
        weakest = c;
      }
    }
    const dominating = this.map.share(RED) > 0.58;
    this.axisCol[RED] = dominating ? weakest : deepest;

    // Spend gold: keep barracks up, then turrets, then a factory.
    // Short grace so the player can take the early initiative.
    if (this.elapsed < AI_GRACE) return;

    // Airstrike on the densest blue pack (keeps a reserve for the garrison)
    if (this.gold[RED] >= COST.strike + GARRISON_COST + 30) {
      const target = this.densestBluePack();
      if (target) {
        this.gold[RED] -= COST.strike;
        this.scheduleStrike(target.x, target.y, RED);
      }
    }

    // Soldier upgrades when comfortable
    const upCost = upgradeCost(this.levels[RED]);
    if (upCost !== null && this.gold[RED] >= upCost + 60) {
      this.buyUpgrade(RED);
      return;
    }

    const mine = this.buildings.filter((b) => !b.dead && b.faction === RED);
    const n = (t: BuildingType) => mine.filter((b) => b.type === t).length;
    const maxBarracks = Math.min(6, 4 + Math.floor(this.elapsed / 90));
    let want: BuildingType | null = null;
    if (n("barracks") < maxBarracks && this.gold[RED] >= COST.barracks) want = "barracks";
    else if (n("turret") < 4 && this.gold[RED] >= COST.turret) want = "turret";
    else if (n("factory") < 2 && this.gold[RED] >= COST.factory) want = "factory";
    else if (this.gold[RED] >= COST.barracks + 40) want = "barracks";
    if (!want) return;

    // A few rows behind the front, near the chosen axis
    for (let tries = 0; tries < 12; tries++) {
      const c = clamp(this.axisCol[RED] + randInt(-3, 3), 0, GRID_W - 1);
      const front = this.map.blueFrontRow(c) - 1;
      const r = clamp(front - randInt(2, 4), 1, GRID_H - 2);
      const i = this.map.idx(c, r);
      if (
        this.map.isLand(c, r) &&
        this.map.owner[i] === RED &&
        !this.buildingAt.has(i) &&
        !this.map.hasDecor(i)
      ) {
        this.gold[RED] -= COST[want];
        this.placeBuilding(RED, want, c, r);
        return;
      }
    }
  }

  /** Best airstrike target: ≥5 blue units packed in a 3×3-tile window. */
  private densestBluePack(): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestCount = 4;
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
    this.buildings.push(b);
    this.buildingAt.set(this.map.idx(c, r), b);
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
    const count = big ? 26 : 12;
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

  private spawnEffect(e: GameObject): void {
    this.effects.push(e);
    this.board.addEntity(e);
  }

  private sweepDead(): void {
    this.sweep(this.units);
    this.sweep(this.bullets);
    this.sweep(this.buildings);
    this.sweep(this.effects);
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
    const win = winner === this.myFaction;
    this.board.stopSound("music_battle", true, 800);
    this.board.playSound(win ? "victory" : "defeat", false, 0.6);

    const data = {
      win,
      time,
      share: this.myFaction === BLUE ? blueShare : 1 - blueShare,
      kills: this.killsBy[this.myFaction],
      losses: this.killsBy[enemyOf(this.myFaction)],
      multi: this.role !== "solo",
      faction: this.myFaction,
    };
    this.addTimer(
      2200,
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
