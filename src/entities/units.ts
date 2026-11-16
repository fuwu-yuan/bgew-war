import { GameObject } from "./gameobject";
import { GameAPI, Target } from "../api";
import { BLUE, COLORS, Faction, MAP_H, RED, VIEW_W } from "../globals";
import { clamp, TAU } from "../utils";
import { srand } from "../sim-rng";
import { BAL } from "../balance";
import { drawSprite, SPR } from "../sprites";

/**
 * Marching unit: walks toward the enemy side along its faction's attack
 * axis, stops to shoot the closest enemy, converts the tile underfoot.
 */
export abstract class Unit extends GameObject {
  public faction: Faction;
  public hp: number;
  public maxHp: number;
  /** Niveaux de force / défense reçus à la production (1 = base). */
  public atk = 1;
  public def = 1;
  /** Network id (multiplayer snapshots) */
  public nid = 0;

  protected game: GameAPI;
  protected dmgVal: number;
  protected range: number;
  protected firePeriod: number;
  protected moveSpd: number;
  protected spr: number;
  protected sprSize: number;
  protected fireSfx: string;
  protected fireSfxVol: number;

  private cd = srand(0.2, 1); // sim: fire cooldown
  private convertCd = srand(0.05, 0.3); // sim: tile-conversion timing
  private lane = srand(-BAL.laneSpread, BAL.laneSpread); // sim: movement lane offset
  private walkT = srand(0, TAU); // seeded: feeds the movement wobble (vx), so it MUST be deterministic
  private walking = false;
  private muzzleT = 0;
  private aimX = 0;
  private aimY = 0;

  protected constructor(
    game: GameAPI,
    faction: Faction,
    cx: number,
    cy: number,
    o: {
      radius: number;
      hp: number;
      dmg: number;
      range: number;
      firePeriod: number;
      speed: number;
      spr: number;
      sprSize: number;
      fireSfx: string;
      fireSfxVol: number;
    }
  ) {
    super(cx, cy, o.radius);
    this.game = game;
    this.faction = faction;
    this.maxHp = this.hp = o.hp;
    this.dmgVal = o.dmg;
    this.range = o.range;
    this.firePeriod = o.firePeriod;
    this.moveSpd = o.speed;
    this.spr = o.spr;
    this.sprSize = o.sprSize;
    this.fireSfx = o.fireSfx;
    this.fireSfxVol = o.fireSfxVol;
    this.aimY = (faction === RED ? 1 : -1) * game.flipY();
  }

  get isTank(): boolean {
    return this.sprSize > 30;
  }

  update(delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.cd -= dt;
    this.muzzleT -= dt;
    this.convertCd -= dt;
    this.walkT += dt;

    const target = this.game.nearestEnemy(this.cx, this.cy, this.faction, this.range);
    if (target) {
      this.walking = false;
      this.aimX = target.cx - this.cx;
      this.aimY = target.cy - this.cy;
      if (this.cd <= 0) {
        this.cd = this.firePeriod * srand(0.85, 1.15);
        this.muzzleT = 0.06;
        this.game.fireBullet(this.cx, this.cy, target, this.dmgVal, this.faction, this.isTank, this.isTank ? BAL.tank.splash : 0);
        this.game.sfx(this.fireSfx, this.fireSfxVol);
      }
    } else {
      this.walking = true;
      this.move(dt);
    }

    // The front line emerges from this: claim the tile underfoot when no
    // enemy is close enough to contest it.
    if (this.convertCd <= 0) {
      this.convertCd = 0.18;
      if (
        this.game.map.ownerAtPx(this.cx, this.cy) !== this.faction &&
        !this.game.nearestEnemy(this.cx, this.cy, this.faction, 70)
      ) {
        this.game.tryConvert(this.cx, this.cy, this.faction);
      }
    }
  }

  private move(dt: number): void {
    const dirY = (this.faction === RED ? 1 : -1) * this.game.flipY();
    let desiredX = this.game.axisX(this.faction) + this.lane;
    let vy = dirY * this.moveSpd;
    // Siège : une fois à hauteur du QG adverse (ou passé derrière), l'unité
    // converge sur lui au lieu de marcher jusqu'au bord de la carte et d'y
    // rester plantée hors de portée de tout.
    const hq = this.game.enemyHq(this.faction);
    if (hq) {
      const dy = hq.cy - this.cy;
      if (Math.abs(dy) < BAL.siegeRadius || Math.sign(dy) !== dirY) {
        desiredX = hq.cx + this.lane * 0.3;
        vy = clamp(dy * 1.4, -this.moveSpd, this.moveSpd);
      }
    }
    let vx = clamp((desiredX - this.cx) * 1.4, -this.moveSpd, this.moveSpd) + Math.sin(this.walkT * 2.6) * 9;

    // March around water: drop the blocked component, slide along the coast
    if (!this.game.map.isLandPx(this.cx, this.cy + vy * dt + Math.sign(vy || dirY) * this.radius)) {
      vy = 0;
      vx = (VIEW_W / 2 > this.cx ? 1 : -1) * this.moveSpd;
    }
    if (!this.game.map.isLandPx(this.cx + vx * dt + Math.sign(vx) * this.radius, this.cy)) {
      vx = 0;
    }

    this.cx = clamp(this.cx + vx * dt, 10, VIEW_W - 10);
    this.cy = clamp(this.cy + vy * dt, 14, MAP_H - 14);
    this.aimX = vx * 0.3;
    this.aimY = dirY;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);

    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.ellipse(this.cx, this.cy + this.sprSize * 0.34, this.sprSize * 0.3, this.sprSize * 0.13, 0, 0, TAU);
    ctx.fill();

    const bob = this.walking ? Math.sin(this.walkT * 11) * 1.6 : 0;
    drawSprite(ctx, this.spr, this.cx, this.cy + bob, this.sprSize);
    drawLevelPips(ctx, this.atk, this.def, this.cx, this.cy - this.sprSize * 0.72);

    if (this.muzzleT > 0) {
      const len = Math.hypot(this.aimX, this.aimY) || 1;
      const mx = this.cx + (this.aimX / len) * this.sprSize * 0.55;
      const my = this.cy + (this.aimY / len) * this.sprSize * 0.55;
      ctx.fillStyle = "#fff2a8";
      ctx.beginPath();
      ctx.arc(mx, my, this.isTank ? 5 : 3, 0, TAU);
      ctx.fill();
    }

    if (this.hp < this.maxHp) {
      const w = this.sprSize * 0.8;
      const x = this.cx - w / 2;
      const y = this.cy - this.sprSize * 0.62;
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(x, y, w, 3);
      ctx.fillStyle = this.faction === BLUE ? "#5dde6a" : "#ffb13d";
      ctx.fillRect(x, y, w * clamp(this.hp / this.maxHp, 0, 1), 3);
    }
  }
}

/** Galons au-dessus des unités améliorées : or = force, bleu clair = défense. */
export function drawLevelPips(ctx: CanvasRenderingContext2D, atk: number, def: number, cx: number, y: number): void {
  const row = (level: number, color: string, yy: number) => {
    const n = Math.min(level - 1, 8);
    if (n <= 0) return;
    const w = n * 5 - 2;
    ctx.fillStyle = color;
    for (let k = 0; k < n; k++) ctx.fillRect(cx - w / 2 + k * 5, yy, 3, 3);
  };
  row(atk, "#ffd95e", y);
  row(def, "#8fd8ff", y - 4);
}

export class Soldier extends Unit {
  constructor(game: GameAPI, faction: Faction, cx: number, cy: number, atk = 1, def = 1) {
    const b = BAL.soldier;
    super(game, faction, cx, cy, {
      radius: 7,
      hp: b.hp + b.up.hp * (def - 1),
      dmg: b.dmg + b.up.dmg * (atk - 1),
      range: b.range + b.up.range * (atk - 1),
      firePeriod: b.firePeriod * Math.pow(b.up.fire, atk - 1),
      speed: srand(b.speedMin, b.speedMax) + b.up.speed * (def - 1),
      spr: faction === BLUE ? SPR.B_SOLDIER : SPR.R_SOLDIER,
      sprSize: 26,
      fireSfx: `shot${1 + Math.floor(Math.random() * 3)}`,
      fireSfxVol: 0.12,
    });
    this.atk = atk;
    this.def = def;
  }
}

export class Tank extends Unit {
  constructor(game: GameAPI, faction: Faction, cx: number, cy: number, atk = 1, def = 1) {
    const b = BAL.tank;
    super(game, faction, cx, cy, {
      radius: 12,
      hp: b.hp + b.up.hp * (def - 1),
      dmg: b.dmg + b.up.dmg * (atk - 1),
      range: b.range + b.up.range * (atk - 1),
      firePeriod: b.firePeriod * Math.pow(b.up.fire, atk - 1),
      speed: b.speed + b.up.speed * (def - 1),
      spr: faction === BLUE ? SPR.B_TANK : SPR.R_TANK,
      sprSize: 36,
      fireSfx: "tankshot",
      fireSfxVol: 0.2,
    });
    this.atk = atk;
    this.def = def;
  }
}

/**
 * Dotted tracer like the ad: a short trail of dots flying to its target.
 * Always connects (auto-battler): damage applies on arrival.
 */
export class Bullet extends GameObject {
  private game: GameAPI;
  private target: Target;
  private dmg: number;
  private faction: Faction;
  private big: boolean;
  private splash: number;
  private vx = 0;
  private vy = 0;
  private life = 1.2;

  constructor(game: GameAPI, x: number, y: number, target: Target, dmg: number, faction: Faction, big: boolean, splash = 0) {
    super(x, y, 2);
    this.game = game;
    this.target = target;
    this.dmg = dmg;
    this.faction = faction;
    this.big = big;
    this.splash = splash;
  }

  update(delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.life -= dt;
    if (this.life <= 0 || (this.target.dead && this.life < 1)) {
      this.dead = true;
      return;
    }
    const speed = this.big ? 330 : 460;
    const dx = this.target.cx - this.cx;
    const dy = this.target.cy - this.cy;
    const d = Math.hypot(dx, dy) || 1;
    this.vx = (dx / d) * speed;
    this.vy = (dy / d) * speed;
    if (d <= speed * dt + 8) {
      this.dead = true;
      this.game.impact(this.target.cx, this.target.cy, this.big);
      if (!this.target.dead) {
        this.target.hp -= this.dmg;
        if (this.target.hp <= 0) this.game.notifyKill(this.target, this.faction);
      }
      // Obus : l'explosion blesse aussi ce qui se serre autour de la cible.
      if (this.splash > 0) {
        this.game.splashDamage(this.target.cx, this.target.cy, this.splash, this.dmg * BAL.splashFrac, this.faction, this.target);
      }
      return;
    }
    this.cx += this.vx * dt;
    this.cy += this.vy * dt;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);
    const d = Math.hypot(this.vx, this.vy) || 1;
    const ux = this.vx / d;
    const uy = this.vy / d;
    ctx.fillStyle = COLORS.bullet;
    const dot = this.big ? 3.5 : 2.2;
    for (let k = 0; k < 3; k++) {
      const px = this.cx - ux * k * 6;
      const py = this.cy - uy * k * 6;
      ctx.globalAlpha = 1 - k * 0.3;
      ctx.fillRect(px - dot / 2, py - dot / 2, dot, dot);
    }
    ctx.globalAlpha = 1;
  }
}
