import { Entity } from "@fuwu-yuan/bgew";
import { BLUE, COLORS, COST, Faction, FONT, MAP_H, VIEW_H, VIEW_W } from "../globals";
import { clamp } from "../utils";
import { drawSprite, SPR } from "../sprites";

export type BuildMode = "barracks" | "turret" | "factory" | "axis" | "strike" | "helico" | null;
export type HudButton = Exclude<BuildMode, null> | "upgrade";

/** What the HUD needs to read from the game step. */
export interface HudState {
  myFaction: Faction;
  myGold: number;
  mode: BuildMode;
  elapsed: number;
  blueShare: number; // 0..1
  axisMarker: { x: number; y: number } | null;
  soldierLevel: number; // my faction's level
  soldierUpgradeCost: number | null; // null at max
}

interface Btn {
  id: HudButton;
  x: number;
  w: number;
  label: string;
  sprRed: number;
  sprBlue: number;
}

const BTN_Y = MAP_H + 7;
const BTN_H = 50;

/**
 * Command panel (bottom strip) + territory bar (top) + attack-axis marker.
 * Hit-testing is done manually by the game step via hitButton() so a single
 * global tap handler drives the whole game (mobile friendly).
 */
export class Hud extends Entity {
  private state: HudState;
  private buttons: Btn[];
  private t = 0;

  constructor(state: HudState) {
    super(0, 0, VIEW_W, VIEW_H);
    this.disabled = true;
    this.state = state;
    const w = 86;
    const gap = 2;
    const x0 = VIEW_W - (w + gap) * 7 - 2;
    const defs: [HudButton, string, number, number][] = [
      ["barracks", "CASERNE", SPR.R_BARRACKS, SPR.B_BARRACKS],
      ["turret", "TOURELLE", SPR.R_TURRET, SPR.B_TURRET],
      ["factory", "USINE", SPR.R_FACTORY, SPR.B_FACTORY],
      ["upgrade", "SOLDATS+", SPR.R_SOLDIER, SPR.B_SOLDIER],
      ["helico", "HELICO", SPR.R_HELI, SPR.B_HELI],
      ["strike", "FRAPPE", SPR.HEDGEHOG, SPR.HEDGEHOG],
      ["axis", "AXE", SPR.RETICLE, SPR.RETICLE],
    ];
    this.buttons = defs.map(([id, label, sprRed, sprBlue], k) => ({
      id,
      label,
      sprRed,
      sprBlue,
      x: x0 + (w + gap) * k,
      w,
    }));
  }

  /** Button under (x, y) — game coords — or null. */
  hitButton(x: number, y: number): HudButton | null {
    if (y < BTN_Y || y > BTN_Y + BTN_H) return null;
    for (const b of this.buttons) {
      if (x >= b.x && x <= b.x + b.w) return b.id;
    }
    return null;
  }

  update(delta: number): void {
    this.t += Math.min(delta, 50) / 1000;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);
    const s = this.state;
    const mine = s.myFaction;

    /* Attack-axis marker on the map */
    if (s.axisMarker) {
      const pulse = 1 + Math.sin(this.t * 5) * 0.12;
      drawSprite(ctx, SPR.RETICLE, s.axisMarker.x, s.axisMarker.y, 44 * pulse);
    }

    /* Build/axis mode hint banner */
    if (s.mode) {
      const myColor = mine === BLUE ? "BLEUE" : "ROUGE";
      const txt =
        s.mode === "axis"
          ? "Touchez une colonne : vos troupes convergeront dessus"
          : s.mode === "strike"
            ? "Touchez la zone a bombarder (degats pour TOUS)"
            : s.mode === "helico"
              ? "Touchez une colonne : sortie d'helico sur cette ligne"
              : `Touchez une case ${myColor} libre pour construire`;
      ctx.fillStyle = "rgba(8, 20, 38, 0.85)";
      ctx.fillRect(0, 26, VIEW_W, 30);
      ctx.fillStyle = "#ffe27a";
      ctx.font = `15px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(txt, VIEW_W / 2, 47);
      ctx.textAlign = "left";
    }

    /* Territory bar (top) — MY side on the left on every screen */
    const myShare = clamp(mine === BLUE ? s.blueShare : 1 - s.blueShare, 0, 1);
    ctx.fillStyle = mine === BLUE ? COLORS.redUnit : COLORS.blueUnit;
    ctx.fillRect(0, 0, VIEW_W, 14);
    ctx.fillStyle = mine === BLUE ? COLORS.blueUnit : COLORS.redUnit;
    ctx.fillRect(0, 0, VIEW_W * myShare, 14);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(VIEW_W * myShare - 1, 0, 2, 14);
    ctx.font = `10px ${FONT}`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`${Math.round(myShare * 100)}%`, 6, 11);
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round((1 - myShare) * 100)}%`, VIEW_W - 6, 11);
    ctx.textAlign = "left";

    /* Bottom panel */
    ctx.fillStyle = COLORS.hudBg;
    ctx.fillRect(0, MAP_H, VIEW_W, VIEW_H - MAP_H);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(0, MAP_H, VIEW_W, 2);

    // Gold (capped display so 4+ digits never bleed into the buttons)
    drawSprite(ctx, SPR.GOLD, 14, MAP_H + 26, 22);
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = COLORS.gold;
    const g = Math.floor(s.myGold);
    ctx.fillText(g > 999 ? "999+" : `${g}`, 27, MAP_H + 31);
    // My flag under the gold
    drawSprite(ctx, mine === BLUE ? SPR.B_FLAG : SPR.R_FLAG, 14, MAP_H + 49, 18);
    ctx.font = `9px ${FONT}`;
    ctx.fillStyle = "#9fc3e4";
    ctx.fillText(mine === BLUE ? "BLEU" : "ROUGE", 26, MAP_H + 53);

    // Buttons
    for (const b of this.buttons) {
      const cost =
        b.id === "upgrade" ? s.soldierUpgradeCost : b.id === "axis" ? 0 : COST[b.id];
      const isUpgrade = b.id === "upgrade";
      const maxed = isUpgrade && cost === null;
      const afford = maxed || cost === 0 || cost === null || s.myGold >= cost;
      const selected = s.mode === b.id;
      ctx.fillStyle = selected ? "rgba(90, 160, 230, 0.45)" : "rgba(255, 255, 255, 0.07)";
      ctx.strokeStyle = selected
        ? "#ffe27a"
        : afford && !maxed
          ? "rgba(140, 190, 235, 0.7)"
          : "rgba(120, 140, 160, 0.35)";
      ctx.lineWidth = selected ? 2.5 : 1.5;
      this.roundRect(ctx, b.x, BTN_Y, b.w, BTN_H, 8);
      ctx.fill();
      ctx.stroke();

      ctx.globalAlpha = afford && !maxed ? 1 : 0.45;
      drawSprite(ctx, mine === BLUE ? b.sprBlue : b.sprRed, b.x + 15, BTN_Y + BTN_H / 2, 24);
      ctx.fillStyle = "#ffffff";
      ctx.font = `10px ${FONT}`;
      const label = isUpgrade ? `${b.label}${s.soldierLevel}` : b.label;
      ctx.fillText(label, b.x + 28, BTN_Y + 20);
      if (maxed) {
        ctx.fillStyle = "#9fc3e4";
        ctx.fillText("MAX", b.x + 28, BTN_Y + 38);
      } else if (cost && cost > 0) {
        ctx.fillStyle = COLORS.gold;
        ctx.fillText(`${cost} or`, b.x + 28, BTN_Y + 38);
      } else {
        ctx.fillStyle = "#bfe1ff";
        ctx.fillText("attaque", b.x + 28, BTN_Y + 38);
      }
      ctx.globalAlpha = 1;
    }
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
