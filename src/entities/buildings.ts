import { GameObject } from "./gameobject";
import { GameAPI } from "../api";
import { BLUE, Faction, RED, TILE } from "../globals";
import { clamp, rand, TAU } from "../utils";
import { drawSprite, SPR } from "../sprites";

export type BuildingType = "hq" | "barracks" | "factory" | "turret";

/** Stable numeric codes for network snapshots */
export const BUILDING_CODE: Record<BuildingType, number> = { hq: 0, barracks: 1, factory: 2, turret: 3 };
export const BUILDING_TYPES: BuildingType[] = ["hq", "barracks", "factory", "turret"];
export const BUILDING_SIZE: Record<BuildingType, number> = { hq: 58, barracks: 38, factory: 38, turret: 38 };
export const BUILDING_SPRITE: Record<BuildingType, [number, number]> = {
  // [red, blue]
  hq: [SPR.R_HQ, SPR.B_HQ],
  barracks: [SPR.R_BARRACKS, SPR.B_BARRACKS],
  factory: [SPR.R_FACTORY, SPR.B_FACTORY],
  turret: [SPR.R_TURRET, SPR.B_TURRET],
};

interface BuildingStats {
  hp: number;
  size: number;
  spawnEvery?: number; // s — barracks/factory
  range?: number; // px — turret
  dmg?: number;
  firePeriod?: number;
}

const STATS: Record<BuildingType, BuildingStats> = {
  // The HQ is a fortress: lots of HP and it shoots back — rushing it
  // without grinding the front first must fail.
  hq: { hp: 150, size: 58, range: 160, dmg: 4, firePeriod: 0.7 },
  barracks: { hp: 16, size: 38, spawnEvery: 2.5 },
  factory: { hp: 20, size: 38, spawnEvery: 9 },
  turret: { hp: 14, size: 38, range: 150, dmg: 2, firePeriod: 0.55 },
};

const SPRITES = BUILDING_SPRITE;

export class Building extends GameObject {
  public faction: Faction;
  public type: BuildingType;
  public hp: number;
  public maxHp: number;
  public col: number;
  public row: number;
  /** Network id (multiplayer snapshots) */
  public nid = 0;
  /** Soldier level its faction spawns at (kept fresh by the game step) */
  public soldierLevel = 1;

  private game: GameAPI;
  private stats: BuildingStats;
  private spawnT: number;
  private cd = 0;
  private muzzleT = 0;
  private aim = { x: 0, y: -1 };

  constructor(game: GameAPI, faction: Faction, type: BuildingType, col: number, row: number) {
    const c = game.map.tileCenter(col, row);
    super(c.x, c.y, STATS[type].size * 0.45);
    this.game = game;
    this.faction = faction;
    this.type = type;
    this.col = col;
    this.row = row;
    this.stats = STATS[type];
    this.maxHp = this.hp = this.stats.hp;
    this.spawnT = (this.stats.spawnEvery ?? 0) * rand(0.3, 1);
    // a building stands on owned ground
    game.map.claim(col, row, faction);
  }

  update(delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.muzzleT -= dt;

    if (this.stats.spawnEvery) {
      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        this.spawnT = this.stats.spawnEvery;
        const dir = this.faction === RED ? 1 : -1;
        const x = this.cx + rand(-14, 14);
        const y = this.cy + dir * (TILE * 0.8);
        if (this.type === "barracks") this.game.spawnSoldier(this.faction, x, y, this.soldierLevel);
        else this.game.spawnTank(this.faction, x, y);
      }
    }

    if (this.stats.range) {
      this.cd -= dt;
      const target = this.game.nearestEnemy(this.cx, this.cy, this.faction, this.stats.range);
      if (target) {
        this.aim.x = target.cx - this.cx;
        this.aim.y = target.cy - this.cy;
        if (this.cd <= 0) {
          this.cd = this.stats.firePeriod ?? 0.6;
          this.muzzleT = 0.06;
          this.game.fireBullet(this.cx, this.cy - 10, target, this.stats.dmg ?? 1, this.faction, false);
          this.game.sfx("turret", 0.1);
        }
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);
    const size = this.stats.size;

    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.ellipse(this.cx, this.cy + size * 0.36, size * 0.4, size * 0.15, 0, 0, TAU);
    ctx.fill();

    drawSprite(ctx, SPRITES[this.type][this.faction === BLUE ? 1 : 0], this.cx, this.cy, size);

    if (this.type === "hq") {
      const flag = this.faction === BLUE ? SPR.B_FLAG : SPR.R_FLAG;
      drawSprite(ctx, flag, this.cx + size * 0.48, this.cy - size * 0.38, 24);
    }

    if (this.muzzleT > 0) {
      const d = Math.hypot(this.aim.x, this.aim.y) || 1;
      ctx.fillStyle = "#fff2a8";
      ctx.beginPath();
      ctx.arc(this.cx + (this.aim.x / d) * size * 0.45, this.cy - 10 + (this.aim.y / d) * size * 0.45, 3.5, 0, TAU);
      ctx.fill();
    }

    if (this.hp < this.maxHp) {
      const w = size * 0.85;
      const x = this.cx - w / 2;
      const y = this.cy - size * 0.62;
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(x, y, w, 4);
      ctx.fillStyle = this.hp / this.maxHp > 0.4 ? "#5dde6a" : "#ff5b4d";
      ctx.fillRect(x, y, w * clamp(this.hp / this.maxHp, 0, 1), 4);
    }
  }
}
