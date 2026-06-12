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
  buildTime?: number; // s — chantier avant d'être opérationnel (HQ: aucun)
}

const STATS: Record<BuildingType, BuildingStats> = {
  // The HQ is a fortress: lots of HP and it shoots back — rushing it
  // without grinding the front first must fail.
  hq: { hp: 150, size: 58, range: 160, dmg: 4, firePeriod: 0.7 },
  barracks: { hp: 16, size: 38, spawnEvery: 2.5, buildTime: 3 },
  factory: { hp: 20, size: 38, spawnEvery: 9, buildTime: 5 },
  turret: { hp: 14, size: 38, range: 150, dmg: 2, firePeriod: 0.55, buildTime: 4 },
};

const SPRITES = BUILDING_SPRITE;

/** Petit ouvrier casqué qui martèle (face à droite, vers le chantier). */
export function drawWorker(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, shirt: string): void {
  const swing = Math.sin(t * 9);
  const bob = Math.abs(swing) * 1.2;
  ctx.save();
  ctx.translate(x, y - bob);
  // jambes
  ctx.fillStyle = "#3a3a4a";
  ctx.fillRect(-3, 4, 2.5, 4);
  ctx.fillRect(0.5, 4, 2.5, 4);
  // corps aux couleurs de la faction
  ctx.fillStyle = shirt;
  ctx.fillRect(-3.5, -2, 7, 6.5);
  // tête + casque de chantier
  ctx.fillStyle = "#f2c79a";
  ctx.beginPath();
  ctx.arc(0, -5, 3, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#ffd23e";
  ctx.beginPath();
  ctx.arc(0, -5.6, 3.2, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(-3.8, -5.6, 7.6, 1.2);
  // bras + marteau qui oscille
  ctx.save();
  ctx.translate(2.5, -1);
  ctx.rotate(-1.1 + swing * 0.7);
  ctx.strokeStyle = "#f2c79a";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(5.5, 0);
  ctx.stroke();
  ctx.fillStyle = "#9aa3ad";
  ctx.fillRect(4.8, -2.4, 3, 4.8);
  ctx.restore();
  // étincelle au sommet du coup
  if (swing > 0.92) {
    ctx.fillStyle = "#fff7c0";
    ctx.beginPath();
    ctx.arc(8.5, -2, 2, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Corps du bâtiment : ombre + sprite, ou chantier (silhouette fantôme,
 * sprite qui monte du sol, barre jaune, ouvrier). Partagé hôte/invité.
 */
export function drawBuildingBody(
  ctx: CanvasRenderingContext2D,
  type: BuildingType,
  faction: number,
  x: number,
  y: number,
  progress: number,
  t: number,
): void {
  const size = BUILDING_SIZE[type];
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.ellipse(x, y + size * 0.36, size * 0.4, size * 0.15, 0, 0, TAU);
  ctx.fill();

  const spr = SPRITES[type][faction === BLUE ? 1 : 0];
  if (progress >= 1) {
    drawSprite(ctx, spr, x, y, size);
    if (type === "hq") {
      drawSprite(ctx, faction === BLUE ? SPR.B_FLAG : SPR.R_FLAG, x + size * 0.48, y - size * 0.38, 24);
    }
    return;
  }

  // silhouette « plan » du futur bâtiment
  ctx.save();
  ctx.globalAlpha *= 0.22;
  drawSprite(ctx, spr, x, y, size);
  ctx.restore();
  // la partie construite monte du sol
  const h = size * clamp(progress, 0, 1);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - size / 2, y + size / 2 - h, size, h);
  ctx.clip();
  drawSprite(ctx, spr, x, y, size);
  ctx.restore();
  // barre de progression jaune (distincte de la barre de vie verte)
  const w = size * 0.85;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(x - w / 2, y - size * 0.62, w, 4);
  ctx.fillStyle = "#ffd95e";
  ctx.fillRect(x - w / 2, y - size * 0.62, w * clamp(progress, 0, 1), 4);

  drawWorker(ctx, x - size * 0.52, y + size * 0.3, t, faction === BLUE ? "#3a9ade" : "#e8533f");
}

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
  private buildLeft = 0;
  private buildTotal = 0;
  private t = rand(0, 10); // horloge d'animation (ouvrier)

  constructor(game: GameAPI, faction: Faction, type: BuildingType, col: number, row: number, instant = false) {
    const c = game.map.tileCenter(col, row);
    super(c.x, c.y, STATS[type].size * 0.45);
    this.game = game;
    this.faction = faction;
    this.type = type;
    this.col = col;
    this.row = row;
    this.stats = STATS[type];
    this.maxHp = this.hp = this.stats.hp;
    if (!instant && this.stats.buildTime) {
      this.buildTotal = this.buildLeft = this.stats.buildTime;
      this.hp = this.maxHp * 0.3; // un chantier est fragile
    }
    this.spawnT = (this.stats.spawnEvery ?? 0) * rand(0.3, 1);
    // a building stands on owned ground
    game.map.claim(col, row, faction);
  }

  /** 1 = opérationnel, < 1 = en chantier. */
  get buildProgress(): number {
    return this.buildTotal > 0 ? 1 - this.buildLeft / this.buildTotal : 1;
  }

  update(delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.t += dt;
    this.muzzleT -= dt;

    if (this.buildLeft > 0) {
      this.buildLeft -= dt;
      this.hp = Math.min(this.hp + (this.maxHp * 0.7 * dt) / this.buildTotal, this.maxHp);
      if (this.buildLeft <= 0) {
        this.buildLeft = 0;
        this.game.impact(this.cx, this.cy - 6, false);
        this.game.sfx("build", 0.4);
      }
      return; // inactif tant que le chantier n'est pas fini
    }

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

    drawBuildingBody(ctx, this.type, this.faction, this.cx, this.cy, this.buildProgress, this.t);
    if (this.buildProgress < 1) return; // la barre jaune du chantier suffit

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
