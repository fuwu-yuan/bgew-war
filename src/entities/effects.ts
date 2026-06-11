import { GameObject } from "./gameobject";
import { FONT, VIEW_W, VIEW_H } from "../globals";
import { rand, TAU } from "../utils";

/** Small square debris/spark — the ad's orange explosions are made of these. */
export class Particle extends GameObject {
  private vx: number;
  private vy: number;
  private life: number;
  private maxLife: number;
  private color: string;
  private size: number;
  private drag: number;

  constructor(
    cx: number,
    cy: number,
    angle: number,
    speed: number,
    color: string,
    opts: { life?: number; size?: number; drag?: number } = {}
  ) {
    super(cx, cy, 2);
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.maxLife = this.life = opts.life ?? rand(0.25, 0.6);
    this.size = opts.size ?? 3;
    this.drag = opts.drag ?? 3;
    this.color = color;
  }

  update(delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.life -= dt;
    if (this.life <= 0) {
      this.dead = true;
      return;
    }
    const d = Math.exp(-this.drag * dt);
    this.vx *= d;
    this.vy *= d;
    this.cx += this.vx * dt;
    this.cy += this.vy * dt;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);
    const t = this.life / this.maxLife;
    ctx.globalAlpha = Math.min(1, t * 1.6);
    ctx.fillStyle = this.color;
    const s = this.size * (0.5 + t * 0.7);
    ctx.fillRect(this.cx - s / 2, this.cy - s / 2, s, s);
  }
}

/** Expanding ring used for big explosions and conquest pulses. */
export class Shockwave extends GameObject {
  private life: number;
  private maxLife: number;
  private maxR: number;
  private color: string;
  private lineW: number;

  constructor(cx: number, cy: number, maxR: number, color: string, life = 0.4, lineW = 3) {
    super(cx, cy, 1);
    this.maxLife = this.life = life;
    this.maxR = maxR;
    this.color = color;
    this.lineW = lineW;
  }

  update(delta: number): void {
    this.life -= Math.min(delta, 50) / 1000;
    if (this.life <= 0) this.dead = true;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);
    const t = 1 - this.life / this.maxLife;
    ctx.globalAlpha = (1 - t) * 0.9;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineW * (1 - t * 0.6);
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, this.maxR * (0.15 + 0.85 * t), 0, TAU);
    ctx.stroke();
  }
}

/** Rising text (gold gains, alerts). */
export class ScorePopup extends GameObject {
  private life: number;
  private maxLife: number;
  private text: string;
  private color: string;
  private size: number;

  constructor(cx: number, cy: number, text: string, color: string, size = 14) {
    super(cx, cy, 1);
    this.maxLife = this.life = 0.9;
    this.text = text;
    this.color = color;
    this.size = size;
  }

  update(delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.life -= dt;
    this.cy -= 34 * dt;
    if (this.life <= 0) this.dead = true;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);
    const t = this.life / this.maxLife;
    ctx.globalAlpha = Math.min(1, t * 2);
    ctx.font = `${this.size}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.strokeText(this.text, this.cx, this.cy);
    ctx.fillStyle = this.color;
    ctx.fillText(this.text, this.cx, this.cy);
    ctx.textAlign = "left";
  }
}

/**
 * Airstrike warning: flashing target circle during the incoming delay.
 * Purely visual — the game step applies the damage when the timer ends.
 */
export class StrikeMarker extends GameObject {
  private life: number;
  private maxLife: number;
  private r: number;

  constructor(cx: number, cy: number, radius: number, delay: number) {
    super(cx, cy, 1);
    this.maxLife = this.life = delay;
    this.r = radius;
  }

  update(delta: number): void {
    this.life -= Math.min(delta, 50) / 1000;
    if (this.life <= 0) this.dead = true;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);
    const t = 1 - this.life / this.maxLife;
    const blink = Math.sin(t * 26) > 0;
    ctx.strokeStyle = blink ? "#ff4b3a" : "#ffd28a";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, this.r * (1 - t * 0.35), 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(this.cx - 12, this.cy);
    ctx.lineTo(this.cx + 12, this.cy);
    ctx.moveTo(this.cx, this.cy - 12);
    ctx.lineTo(this.cx, this.cy + 12);
    ctx.stroke();
  }
}

/**
 * Visual-only dotted tracer (multiplayer guest side): flies from A to B in
 * a fixed time, no gameplay effect — the host already resolved the damage.
 */
export class Tracer extends GameObject {
  private x0: number;
  private y0: number;
  private x1: number;
  private y1: number;
  private life: number;
  private maxLife: number;
  private big: boolean;

  constructor(x0: number, y0: number, x1: number, y1: number, big: boolean) {
    super(x0, y0, 2);
    this.x0 = x0;
    this.y0 = y0;
    this.x1 = x1;
    this.y1 = y1;
    this.big = big;
    this.maxLife = this.life = Math.min(0.35, Math.hypot(x1 - x0, y1 - y0) / (big ? 330 : 460));
  }

  update(delta: number): void {
    this.life -= Math.min(delta, 50) / 1000;
    if (this.life <= 0) this.dead = true;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);
    const t = 1 - Math.max(0, this.life / this.maxLife);
    const px = this.x0 + (this.x1 - this.x0) * t;
    const py = this.y0 + (this.y1 - this.y0) * t;
    const d = Math.hypot(this.x1 - this.x0, this.y1 - this.y0) || 1;
    const ux = (this.x1 - this.x0) / d;
    const uy = (this.y1 - this.y0) / d;
    ctx.fillStyle = "#fff4c2";
    const dot = this.big ? 3.5 : 2.2;
    for (let k = 0; k < 3; k++) {
      ctx.globalAlpha = 1 - k * 0.3;
      ctx.fillRect(px - ux * k * 6 - dot / 2, py - uy * k * 6 - dot / 2, dot, dot);
    }
    ctx.globalAlpha = 1;
  }
}

/**
 * Fullscreen fade used for step transitions (the engine's moveToStep fade
 * draws at world 0,0 — this one is camera-independent because camera is 0).
 */
export class Fader extends GameObject {
  private life: number;
  private maxLife: number;
  private from: number;
  private to: number;
  private color: string;
  private done?: () => void;
  private fired = false;

  constructor(from: number, to: number, ms: number, color = "#08111f", done?: () => void) {
    super(VIEW_W / 2, VIEW_H / 2, 1);
    this.maxLife = this.life = ms / 1000;
    this.from = from;
    this.to = to;
    this.color = color;
    this.done = done;
  }

  update(delta: number): void {
    this.life -= Math.min(delta, 50) / 1000;
    if (this.life <= 0 && !this.fired) {
      this.fired = true;
      this.dead = this.to === 0;
      if (this.done) this.done();
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);
    const t = Math.max(0, Math.min(1, 1 - this.life / this.maxLife));
    const a = this.from + (this.to - this.from) * t;
    if (a <= 0.002) return;
    ctx.globalAlpha = Math.min(1, a);
    ctx.fillStyle = this.color;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }
}
