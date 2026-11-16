import { GameObject } from "./gameobject";
import type { GameAPI } from "../api";
import { BLUE, Faction, MAP_H, RED, VIEW_W } from "../globals";
import { BAL } from "../balance";
import { clamp, TAU } from "../utils";
import { srand } from "../sim-rng";
import { drawSprite, SPR } from "../sprites";

/** Rendu partagé hôte/invité : ombre décalée au sol, sprite qui plane, rotor animé. */
export function drawHeli(
  ctx: CanvasRenderingContext2D,
  faction: number,
  x: number,
  y: number,
  t: number,
  returning = false,
): void {
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.ellipse(x + 7, y + 18, 11, 4.5, 0, 0, TAU);
  ctx.fill();

  const hover = Math.sin(t * 3) * 1.5;
  ctx.save();
  ctx.translate(x, y - 8 + hover);
  if (returning) ctx.rotate(Math.PI);
  drawSprite(ctx, faction === BLUE ? SPR.B_HELI : SPR.R_HELI, 0, 0, 34);
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 1.5;
  const a = t * 16;
  for (const k of [0, Math.PI / 2]) {
    ctx.beginPath();
    ctx.moveTo(Math.cos(a + k) * 11, Math.sin(a + k) * 11);
    ctx.lineTo(-Math.cos(a + k) * 11, -Math.sin(a + k) * 11);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Sortie d'hélico : décolle de la ligne arrière, traverse la carte en
 * mitraillant ce qu'il survole, fait demi-tour au bord ennemi et rentre
 * (despawn silencieux à la maison). Il ne convertit pas les tuiles — la
 * guerre se gagne au sol. Volontairement hors des buckets sol : les
 * unités ne peuvent pas le viser, seuls tourelles et QG le ciblent via
 * nearestAirEnemy.
 */
export class Helicopter extends GameObject {
  public faction: Faction;
  public hp = BAL.heli.hp;
  public maxHp = BAL.heli.hp;
  public nid = 0;
  public returning = false;

  private game: GameAPI;
  private t = srand(0, TAU); // seeded: feeds the heli's cx drift, must be deterministic
  private fireCd = 0.5; // petit délai de décollage avant la première rafale
  private fuel = BAL.heli.fuel; // s d'autonomie à l'aller ; à sec, il rentre
  private strafing = false; // une cible à portée au dernier tir : il ralentit pour mitrailler

  constructor(game: GameAPI, faction: Faction, cx: number, cy: number) {
    super(cx, cy, 13);
    this.game = game;
    this.faction = faction;
  }

  update(delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.t += dt;
    this.fireCd -= dt;

    const dir = (this.faction === RED ? 1 : -1) * this.game.flipY(); // vers l'ennemi (miroir-safe)
    // Appui-feu : à l'aller, il ralentit tant qu'il a une cible sous ses canons
    // (il reste sur le front au lieu de le traverser en 3 s). Son autonomie est
    // comptée : à sec, il fait demi-tour où qu'il soit.
    this.fuel -= dt;
    if (!this.returning && this.fuel <= 0) this.returning = true;
    const pace = !this.returning && this.strafing ? BAL.heli.strafeSlow : 1;
    this.cy += (this.returning ? -dir : dir) * BAL.heli.speed * pace * dt;
    this.cx = clamp(this.cx + Math.sin(this.t * 1.6) * 16 * dt, 18, VIEW_W - 18);
    if (!this.returning && (dir > 0 ? this.cy >= MAP_H - BAL.heli.turnBack : this.cy <= BAL.heli.turnBack)) {
      this.returning = true;
    } else if (this.returning && (dir > 0 ? this.cy <= 44 : this.cy >= MAP_H - 44)) {
      this.dead = true; // rentré à la base, sans explosion
      return;
    }

    // Strafe en vol continu : il ne s'arrête jamais
    if (this.fireCd <= 0) {
      const target = this.game.nearestEnemy(this.cx, this.cy, this.faction, BAL.heli.range);
      this.strafing = !!target;
      if (target) {
        this.fireCd = BAL.heli.firePeriod * srand(0.85, 1.15);
        this.game.fireBullet(this.cx, this.cy, target, BAL.heli.dmg, this.faction, false);
        this.game.sfx("shot2", 0.1);
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);
    drawHeli(ctx, this.faction, this.cx, this.cy, this.t, this.returning);
    if (this.hp < this.maxHp) {
      const w = 26;
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(this.cx - w / 2, this.cy - 26, w, 3);
      ctx.fillStyle = this.faction === BLUE ? "#5dde6a" : "#ffb13d";
      ctx.fillRect(this.cx - w / 2, this.cy - 26, w * clamp(this.hp / this.maxHp, 0, 1), 3);
    }
  }
}
