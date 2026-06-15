import { Board, Entity, GameStep } from "@fuwu-yuan/bgew";
import { COLORS, FONT, VIEW_H, VIEW_W } from "../globals";
import { clamp, rand, TAU } from "../utils";
import { Fader, Particle, Shockwave } from "../entities/effects";
import { GameObject } from "../entities/gameobject";
import { drawSprite, SPR } from "../sprites";
import { preloadMenuData } from "../firebase";
import { trackScreen } from "../analytics";

/* ------------------------------------------------------------------ *
 * Cinematic boot splash. Two armies charge a glowing front line, slam
 * into it, and the impact births the BGEW WAR logo with a shake + a
 * particle burst. Tagline wipes in, a prompt pulses, then it fades to
 * the menu (auto after T_DUR, or instantly on any tap / key).
 *
 * Pure canvas — no extra assets. `?splash=off` skips it (used by tests).
 * ------------------------------------------------------------------ */

const T_SWEEP = 0.55; // territory tint sweeps in
const T_MARCH = 0.35; // armies start charging
const T_IMPACT = 1.4; // the clash + logo slam
const T_SUB = 2.0; // tagline wipe
const T_PROMPT = 2.6; // earliest the "touchez pour commencer" prompt may appear
const T_MAXWAIT = 7.0; // show the prompt even if the preload never answers

const MID = VIEW_H / 2;
const clamp01 = (x: number) => clamp(x, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
// Overshoot ease — the logo punches past full size then settles back.
const easeOutBack = (x: number) => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

/** Everything is drawn here, driven by a single elapsed clock. */
class SplashArt extends Entity {
  public ready = false; // set by the step once the animation AND preload are done
  private t = 0;

  constructor() {
    super(0, 0, VIEW_W, VIEW_H);
    this.disabled = true;
  }

  update(delta: number): void {
    this.t += Math.min(delta, 50) / 1000;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);
    const t = this.t;
    const W = VIEW_W;
    const H = VIEW_H;

    // Impact screen-shake (decays over half a second)
    const ai = t - T_IMPACT;
    let sx = 0;
    let sy = 0;
    if (ai >= 0 && ai < 0.5) {
      const amp = (1 - ai / 0.5) * 16;
      sx = Math.cos(t * 71) * amp;
      sy = Math.sin(t * 59) * amp;
    }
    ctx.save();
    ctx.translate(sx, sy);

    // Background — deep navy, slightly lit top & bottom (the two camps)
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0c2238");
    bg.addColorStop(0.5, "#081222");
    bg.addColorStop(1, "#0c2238");
    ctx.fillStyle = bg;
    ctx.fillRect(-24, -24, W + 48, H + 48);

    // Faction territory glows sweeping toward the centre line
    const sweep = easeOutCubic(clamp01(t / T_SWEEP));
    const wash = clamp01(1 - Math.max(0, t - T_IMPACT) / 0.4); // washes out at impact
    this.factionGlow(ctx, true, sweep * wash);
    this.factionGlow(ctx, false, sweep * wash);

    // Charging armies (faded out just after the clash so the logo owns it)
    const march = easeOutCubic(clamp01((t - T_MARCH) / (T_IMPACT - T_MARCH)));
    const armyA = clamp01(1 - Math.max(0, t - T_IMPACT - 0.05) / 0.35);
    if (armyA > 0.01) this.armies(ctx, march, armyA, t);

    // The front line ignites as the armies close in
    const beam = march * wash;
    if (beam > 0.01) this.frontLine(ctx, beam, t);

    // Impact flash — white-out that the logo emerges from
    if (ai >= 0) {
      const fl = Math.max(0, 1 - ai / 0.32);
      if (fl > 0) {
        ctx.globalAlpha = fl;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(-24, -24, W + 48, H + 48);
        ctx.globalAlpha = 1;
      }
    }

    // Logo slam
    if (ai >= 0) this.logo(ctx, clamp01(ai / 0.5), t);

    // Tagline wipe
    if (t >= T_SUB) this.tagline(ctx, clamp01((t - T_SUB) / 0.5));

    // Pulsing start prompt + engine credit — only once everything's loaded.
    if (this.ready) {
      const pulse = 0.45 + 0.55 * Math.abs(Math.sin(t * 3));
      ctx.textAlign = "center";
      ctx.font = `16px ${FONT}`;
      ctx.fillStyle = `rgba(255, 226, 122, ${pulse})`;
      ctx.fillText("TOUCHEZ POUR COMMENCER", W / 2, H - 132);
      ctx.font = `11px ${FONT}`;
      ctx.fillStyle = "rgba(190, 215, 240, 0.5)";
      ctx.fillText("UN JEU BGEW — LE BAGUETTE GAME ENGINE WEB", W / 2, H - 60);
      ctx.textAlign = "left";
    }

    ctx.restore();
  }

  /** Radial wash of a faction colour bleeding in from the top/bottom edge. */
  private factionGlow(ctx: CanvasRenderingContext2D, red: boolean, a: number): void {
    if (a <= 0.01) return;
    const cy = red ? -40 : VIEW_H + 40;
    const g = ctx.createRadialGradient(VIEW_W / 2, cy, 40, VIEW_W / 2, cy, VIEW_H * 0.72);
    const col = red ? COLORS.redUnit : COLORS.blueUnit;
    g.addColorStop(0, this.rgba(col, 0.55 * a));
    g.addColorStop(1, this.rgba(col, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  /** Rows of sprites converging on the centre line, with a marching bob. */
  private armies(ctx: CanvasRenderingContext2D, march: number, alpha: number, t: number): void {
    ctx.globalAlpha = alpha;
    const cols = [0.13, 0.3, 0.5, 0.7, 0.87];
    const redY = lerp(-46, MID - 36, march);
    const blueY = lerp(VIEW_H + 46, MID + 36, march);
    cols.forEach((f, i) => {
      const x = f * VIEW_W;
      const bob = Math.sin(t * 9 + i) * 3;
      const tank = i === 2; // a tank spearheads the centre column
      // Red (top), charging down
      drawSprite(ctx, tank ? SPR.R_TANK : SPR.R_SOLDIER, x, redY + bob - i * 4, tank ? 46 : 34);
      if (!tank) drawSprite(ctx, SPR.R_SOLDIER, x + 16, redY - 26 + bob, 26);
      // Blue (bottom), charging up
      drawSprite(ctx, tank ? SPR.B_TANK : SPR.B_SOLDIER, x, blueY - bob + i * 4, tank ? 46 : 34);
      if (!tank) drawSprite(ctx, SPR.B_SOLDIER, x - 16, blueY + 26 - bob, 26);
    });
    // Flags rallying behind each line
    drawSprite(ctx, SPR.R_FLAG, VIEW_W / 2, redY - 54, 30);
    drawSprite(ctx, SPR.B_FLAG, VIEW_W / 2, blueY + 54, 30);
    ctx.globalAlpha = 1;
  }

  /** Glowing horizontal seam where the fronts meet, with flickering sparks. */
  private frontLine(ctx: CanvasRenderingContext2D, beam: number, t: number): void {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const h = 5 + beam * 13 + Math.sin(t * 26) * 2.5;
    const g = ctx.createLinearGradient(0, MID - h, 0, MID + h);
    g.addColorStop(0, "rgba(255, 210, 120, 0)");
    g.addColorStop(0.5, `rgba(255, 240, 190, ${0.45 + 0.55 * beam})`);
    g.addColorStop(1, "rgba(255, 210, 120, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, MID - h, VIEW_W, 2 * h);
    // Sparks dancing along the seam (deterministic, no entity spawns)
    ctx.fillStyle = "#fff4c2";
    for (let i = 0; i < 22; i++) {
      const px = ((i * 97 + Math.sin(t * 12 + i) * 40) % VIEW_W + VIEW_W) % VIEW_W;
      const py = MID + Math.sin(t * 30 + i * 2) * h * 0.8;
      const s = (Math.sin(t * 40 + i) * 0.5 + 0.5) * 2.6 * beam;
      ctx.globalAlpha = beam;
      ctx.fillRect(px - s / 2, py - s / 2, s, s);
    }
    ctx.restore();
  }

  /** BGEW / WAR slamming in with overshoot, neon glow and a glint sweep. */
  private logo(ctx: CanvasRenderingContext2D, p: number, t: number): void {
    const scale = lerp(2.7, 1, easeOutBack(p));
    const alpha = clamp01(p * 2.6);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(VIEW_W / 2, MID - 6);
    ctx.scale(scale, scale);
    ctx.textAlign = "center";

    // Glow pass
    ctx.shadowColor = "rgba(127, 209, 255, 0.9)";
    ctx.shadowBlur = 26;
    ctx.lineWidth = 10;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.font = `92px ${FONT}`;
    ctx.strokeText("BGEW", 0, -8);
    ctx.fillStyle = "#ffffff";
    ctx.fillText("BGEW", 0, -8);

    ctx.font = `116px ${FONT}`;
    ctx.shadowColor = "rgba(232, 83, 63, 0.9)";
    ctx.strokeText("WAR", 0, 96);
    const grad = ctx.createLinearGradient(0, 20, 0, 104);
    grad.addColorStop(0, COLORS.redTileA);
    grad.addColorStop(1, COLORS.blueUnit);
    ctx.fillStyle = grad;
    ctx.shadowBlur = 0;
    ctx.fillText("WAR", 0, 96);
    ctx.restore();

    // Glint: a bright bar sweeping across the settled logo, once.
    const gp = (t - T_IMPACT - 0.45) / 0.6;
    if (gp > 0 && gp < 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(VIEW_W / 2 - 240, MID - 80, 480, 200);
      ctx.clip();
      ctx.globalCompositeOperation = "lighter";
      const gx = lerp(VIEW_W / 2 - 280, VIEW_W / 2 + 280, gp);
      const band = ctx.createLinearGradient(gx - 60, 0, gx + 60, 0);
      band.addColorStop(0, "rgba(255,255,255,0)");
      band.addColorStop(0.5, `rgba(255,255,255,${0.5 * (1 - Math.abs(gp - 0.5) * 2)})`);
      band.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = band;
      ctx.fillRect(VIEW_W / 2 - 240, MID - 80, 480, 200);
      ctx.restore();
    }
  }

  /** Tagline revealed by a clip that opens from the centre outward. */
  private tagline(ctx: CanvasRenderingContext2D, p: number): void {
    const halfW = easeOutCubic(p) * 280;
    ctx.save();
    ctx.beginPath();
    ctx.rect(VIEW_W / 2 - halfW, MID + 116, halfW * 2, 40);
    ctx.clip();
    ctx.textAlign = "center";
    ctx.font = `18px ${FONT}`;
    ctx.fillStyle = "#bfd9f2";
    ctx.fillText("LA GUERRE DU TERRITOIRE", VIEW_W / 2, MID + 144);
    ctx.restore();
  }

  private rgba(hex: string, a: number): string {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
}

export class SplashStep extends GameStep {
  name = "splash";
  private art!: SplashArt;
  private t = 0;
  private burst = false;
  private leaving = false;
  private preloaded = false;
  private ready = false; // animation settled AND data warmed → prompt is live
  private effects: GameObject[] = []; // burst particles/rings, swept when dead

  constructor(board: Board) {
    super(board);
    // Registered once (board listeners survive step changes — see CLAUDE.md).
    // The animation can NOT be skipped: a tap only counts once `ready`, i.e.
    // once the prompt is showing and the menu data is loaded.
    board.onMouseEvent("click", () => {
      if (board.step === this && this.ready) this.goMenu();
    });
    board.onKeyboardEvent("keydown", () => {
      if (board.step === this && this.ready) this.goMenu();
    });
  }

  onEnter(): void {
    this.t = 0;
    this.burst = false;
    this.leaving = false;
    this.preloaded = false;
    this.ready = false;
    this.effects = [];
    this.camera.x = 0;
    this.camera.y = 0;
    trackScreen("splash");
    this.art = new SplashArt();
    this.board.addEntity(this.art);
    this.board.addEntity(new Fader(1, 0, 450));
    // Warm the menu data (auth, pseudo, leaderboard) during the animation so
    // the menu is fully ready the instant the player taps to continue.
    preloadMenuData()
      .then(() => (this.preloaded = true))
      .catch(() => (this.preloaded = true));
  }

  onLeave(): void {}

  update(delta: number): void {
    super.update(delta); // drives the art + any spawned particles
    this.t += Math.min(delta, 50) / 1000;
    if (!this.burst && this.t >= T_IMPACT) {
      this.burst = true;
      this.impactBurst();
    }
    // Sweep finished particles/rings: once dead they'd keep drawing with a
    // negative life — the canvas ignores a negative globalAlpha (so they stay
    // opaque) and the size term flips sign (so they grow). Remove them.
    if (this.effects.length) {
      for (const e of this.effects) if (e.dead) this.board.removeEntity(e);
      this.effects = this.effects.filter((e) => !e.dead);
    }
    // The prompt appears only when the show is done AND everything's loaded
    // (with a safety cap so a dead network can't trap the player forever).
    this.ready = this.t >= T_PROMPT && (this.preloaded || this.t >= T_MAXWAIT);
    this.art.ready = this.ready;
  }

  /** The clash explosion: shockwave rings + a fan of faction/gold debris. */
  private impactBurst(): void {
    const cx = VIEW_W / 2;
    const cy = VIEW_H / 2;
    const add = (e: GameObject) => {
      this.board.addEntity(e);
      this.effects.push(e);
    };
    add(new Shockwave(cx, cy, 260, "#ffe9b0", 0.55, 5));
    add(new Shockwave(cx, cy, 170, "#7fd1ff", 0.45, 4));
    add(new Shockwave(cx, cy, 200, "#ff8b7a", 0.5, 4));
    const palette = ["#ffd95e", "#fff4c2", COLORS.redUnit, COLORS.blueUnit, "#ffffff"];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * TAU + rand(-0.15, 0.15);
      const col = palette[i % palette.length];
      add(new Particle(cx, cy, a, rand(220, 560), col, { life: rand(0.5, 1.0), size: rand(2, 5), drag: rand(1.6, 3) }));
    }
  }

  private goMenu(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.board.addEntity(
      new Fader(0, 1, 420, "#08111f", () => {
        this.board.moveToStep("menu", {});
      })
    );
  }
}
