import { Entity } from "@fuwu-yuan/bgew";
import { BLUE, COLORS, COST, Faction, FONT, MAP_H, VIEW_H, VIEW_W } from "../globals";
import { clamp } from "../utils";
import { drawSprite, SPR } from "../sprites";
import { drawMuteIcon, isMuted } from "../sound";

export type BuildMode = "barracks" | "turret" | "factory" | "axis" | "strike" | "helico" | null;
export type UpgradeButton = "upgradeSoldier" | "upgradeTank" | "upgradeTurret";
export type HudButton = Exclude<BuildMode, null> | UpgradeButton;

/** What the HUD needs to read from the game step. */
export interface HudState {
  myFaction: Faction;
  myGold: number;
  mode: BuildMode;
  elapsed: number;
  blueShare: number; // 0..1
  axisMarker: { x: number; y: number } | null;
  soldierLevel: number; // my faction's level
  soldierUpgradeCost: number;
  tankLevel: number;
  tankUpgradeCost: number;
  turretLevel: number;
  turretUpgradeCost: number;
  myName: string; // local player's name (left, my unit color)
  enemyName: string; // opponent's name (right, enemy unit color)
}

interface Btn {
  id: HudButton;
  x: number;
  y: number;
  w: number;
  label: string;
  key: string; // keyboard shortcut (single uppercase letter)
  sprRed: number;
  sprBlue: number;
}

const BTN_H = 46;
const BTN_GAP = 4;

/** Mute toggle — top-right strip of the command panel, above the buttons. */
const MUTE_R = 15;
const MUTE_CX = VIEW_W - 26;
const MUTE_CY = MAP_H + 20;

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
    const w = 84;
    const commandY = MAP_H + 88;
    const upgradeY = MAP_H + 32;
    const x0 = 112;
    // Build/mode keys mirror the French label initials; the three upgrades
    // get S / R / K (Soldats / touRelle / tanK) to avoid clashing with them.
    const defs: [HudButton, string, string, number, number][] = [
      ["barracks", "CASERNE", "C", SPR.R_BARRACKS, SPR.B_BARRACKS],
      ["turret", "TOURELLE", "T", SPR.R_TURRET, SPR.B_TURRET],
      ["factory", "USINE", "U", SPR.R_FACTORY, SPR.B_FACTORY],
      ["helico", "HELICO", "H", SPR.R_HELI, SPR.B_HELI],
      ["strike", "FRAPPE", "F", SPR.HEDGEHOG, SPR.HEDGEHOG],
      ["axis", "AXE", "A", SPR.RETICLE, SPR.RETICLE],
      ["upgradeSoldier", "SOLDATS", "S", SPR.R_SOLDIER, SPR.B_SOLDIER],
      ["upgradeTurret", "TOUREL.", "R", SPR.R_TURRET, SPR.B_TURRET],
      ["upgradeTank", "TANKS", "K", SPR.R_TANK, SPR.B_TANK],
    ];
    this.buttons = defs.map(([id, label, key, sprRed, sprBlue], k) => {
      const upgrade = id === "upgradeSoldier" || id === "upgradeTank" || id === "upgradeTurret";
      const rowK = upgrade ? k - 6 : k;
      return {
        id,
        label,
        key,
        sprRed,
        sprBlue,
        x: x0 + (w + BTN_GAP) * rowK,
        y: upgrade ? upgradeY : commandY,
        w,
      };
    });
  }

  /** The mute toggle is hit (game coords) — checked before build taps. */
  hitMute(x: number, y: number): boolean {
    return Math.abs(x - MUTE_CX) <= MUTE_R + 4 && Math.abs(y - MUTE_CY) <= MUTE_R + 4;
  }

  /** Button under (x, y) — game coords — or null. */
  hitButton(x: number, y: number): HudButton | null {
    for (const b of this.buttons) {
      if (y >= b.y && y <= b.y + BTN_H && x >= b.x && x <= b.x + b.w) return b.id;
    }
    return null;
  }

  /** Button bound to a keyboard key (case-insensitive) — or null. */
  buttonForKey(key: string): HudButton | null {
    const k = key.toUpperCase();
    return this.buttons.find((b) => b.key === k)?.id ?? null;
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

    /* Player names (thin band under the territory bar) — me on the left in my
       unit color, the enemy on the right in theirs. Names are truncated so
       they never reach the center. */
    const myColor = mine === BLUE ? COLORS.blueUnit : COLORS.redUnit;
    const enemyColor = mine === BLUE ? COLORS.redUnit : COLORS.blueUnit;
    ctx.font = `10px ${FONT}`;
    ctx.fillStyle = myColor;
    ctx.textAlign = "left";
    ctx.fillText(this.trunc(s.myName), 6, 24);
    ctx.fillStyle = enemyColor;
    ctx.textAlign = "right";
    ctx.fillText(this.trunc(s.enemyName), VIEW_W - 6, 24);
    ctx.textAlign = "left";

    /* Bottom panel */
    ctx.fillStyle = COLORS.hudBg;
    ctx.fillRect(0, MAP_H, VIEW_W, VIEW_H - MAP_H);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(0, MAP_H, VIEW_W, 2);

    // Gold (capped display so 4+ digits never bleed into the buttons)
    drawSprite(ctx, SPR.GOLD, 18, MAP_H + 44, 24);
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = COLORS.gold;
    const g = Math.floor(s.myGold);
    ctx.fillText(g > 99999 ? "99999+" : `${g}`, 33, MAP_H + 49);
    // My flag under the gold
    drawSprite(ctx, mine === BLUE ? SPR.B_FLAG : SPR.R_FLAG, 18, MAP_H + 74, 18);
    ctx.font = `9px ${FONT}`;
    ctx.fillStyle = "#9fc3e4";
    ctx.fillText(mine === BLUE ? "BLEU" : "ROUGE", 32, MAP_H + 78);

    // Mute toggle
    drawMuteIcon(ctx, MUTE_CX, MUTE_CY, MUTE_R, isMuted());

    // Buttons
    for (const b of this.buttons) {
      const isUpgrade = b.id === "upgradeSoldier" || b.id === "upgradeTank" || b.id === "upgradeTurret";
      let cost = 0;
      if (b.id === "upgradeTank") cost = s.tankUpgradeCost;
      else if (b.id === "upgradeTurret") cost = s.turretUpgradeCost;
      else if (b.id === "upgradeSoldier") cost = s.soldierUpgradeCost;
      else if (b.id !== "axis") cost = COST[b.id];
      const afford = cost === 0 || s.myGold >= cost;
      const selected = !isUpgrade && s.mode === b.id;
      ctx.fillStyle = selected ? "rgba(90, 160, 230, 0.45)" : "rgba(255, 255, 255, 0.07)";
      ctx.strokeStyle = selected
        ? "#ffe27a"
        : afford
          ? "rgba(140, 190, 235, 0.7)"
          : "rgba(120, 140, 160, 0.35)";
      ctx.lineWidth = selected ? 2.5 : 1.5;
      this.roundRect(ctx, b.x, b.y, b.w, BTN_H, 7);
      ctx.fill();
      ctx.stroke();

      ctx.globalAlpha = afford ? 1 : 0.45;
      drawSprite(ctx, mine === BLUE ? b.sprBlue : b.sprRed, b.x + 13, b.y + BTN_H / 2, 22);
      ctx.fillStyle = "#ffffff";
      ctx.font = `8px ${FONT}`;
      const level =
        b.id === "upgradeTank" ? s.tankLevel : b.id === "upgradeTurret" ? s.turretLevel : s.soldierLevel;
      const label = isUpgrade ? `${b.label} ${level}` : b.label;
      ctx.fillText(label, b.x + 25, b.y + 18);
      if (cost && cost > 0) {
        ctx.fillStyle = COLORS.gold;
        ctx.font = `8px ${FONT}`;
        ctx.fillText(`${cost} or`, b.x + 25, b.y + 35);
      } else {
        ctx.fillStyle = "#bfe1ff";
        ctx.fillText("attaque", b.x + 25, b.y + 35);
      }

      // Keyboard shortcut badge (bottom-right corner — clear of the label at
      // the top and the cost at bottom-left), full opacity even when dimmed.
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(8, 20, 38, 0.72)";
      this.roundRect(ctx, b.x + b.w - 17, b.y + BTN_H - 17, 13, 13, 3);
      ctx.fill();
      ctx.fillStyle = selected ? "#ffffff" : "#ffe27a";
      ctx.font = `9px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(b.key, b.x + b.w - 10.5, b.y + BTN_H - 7.5);
      ctx.textAlign = "left";
    }
  }

  /** Keep names short enough to never collide with the center percentages. */
  private trunc(name: string): string {
    return name.length > 14 ? `${name.slice(0, 13)}.` : name;
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
