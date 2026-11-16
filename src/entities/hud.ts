import { Entity } from "@fuwu-yuan/bgew";
import { BLUE, COLORS, COST, Faction, FONT, MAP_H, VIEW_H, VIEW_W } from "../globals";
import { clamp } from "../utils";
import type { UpgradeKind, UpgradeStat } from "../balance";
import { drawSprite, SPR } from "../sprites";
import { drawMuteIcon, isMuted } from "../sound";

export type BuildMode = "barracks" | "turret" | "factory" | "axis" | "strike" | "helico" | null;
export type UpgradeButton = `up:${UpgradeKind}:${UpgradeStat}`;
export type HudButton = Exclude<BuildMode, null> | UpgradeButton;

/** What the HUD needs to read from the game step. */
export interface HudState {
  myFaction: Faction;
  myGold: number;
  mode: BuildMode;
  elapsed: number;
  /** Mort subite en cours : le QG du camp minoritaire en territoire s'effrite. */
  suddenDeath: boolean;
  blueShare: number; // 0..1
  axisMarker: { x: number; y: number } | null;
  /** Mon niveau / le prix du niveau suivant, par branche et par voie (force, défense). */
  upLevel(kind: UpgradeKind, stat: UpgradeStat): number;
  upCost(kind: UpgradeKind, stat: UpgradeStat): number;
  /** Prix actuel d'un bâtiment (il monte avec le nombre possédé). */
  buildCostOf(kind: "barracks" | "factory" | "turret"): number;
  myName: string; // local player's name (left, my unit color)
  enemyName: string; // opponent's name (right, enemy unit color)
  /** Niveau CLAUDE : réplique du général (affichée CLAUDE_SAY_FOR s) + témoin « réfléchit ». */
  enemySay: string;
  enemySayAge: number; // s depuis la réplique
  enemyThinking: boolean;
}

const SAY_FOR = 8; // s

interface Btn {
  id: HudButton;
  /** Bouton d'amélioration : branche + voie (null pour bâtiments/ordres). */
  up: { kind: UpgradeKind; stat: UpgradeStat } | null;
  x: number;
  y: number;
  w: number;
  label: string;
  key: string; // keyboard shortcut (single uppercase letter)
  sprRed: number;
  sprBlue: number;
}

const BTN_H = 42;
const BTN_GAP = 4;

/** Mute toggle — top-right strip of the command panel, above the buttons. */
const MUTE_R = 15;
const MUTE_CX = VIEW_W - 26;
const MUTE_CY = MAP_H + 26;

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
    // Trois lignes : DÉFENSE (haut), FORCE (milieu), bâtiments et ordres (bas).
    const defY = MAP_H + 5;
    const atkY = MAP_H + 51;
    const commandY = MAP_H + 97;
    const x0 = 112;
    const commands: [HudButton, string, string, number, number][] = [
      ["barracks", "CASERNE", "C", SPR.R_BARRACKS, SPR.B_BARRACKS],
      ["turret", "TOURELLE", "T", SPR.R_TURRET, SPR.B_TURRET],
      ["factory", "USINE", "U", SPR.R_FACTORY, SPR.B_FACTORY],
      ["helico", "HELICO", "H", SPR.R_HELI, SPR.B_HELI],
      ["strike", "FRAPPE", "F", SPR.HEDGEHOG, SPR.HEDGEHOG],
      ["axis", "AXE", "A", SPR.RETICLE, SPR.RETICLE],
    ];
    // Améliorations, mêmes colonnes sur les deux lignes. Raccourcis : force
    // S / K / R / L (Soldats, tanK, touRelle, héLico), défense 1 / 2 / 3 / 4.
    const branches: [UpgradeKind, string, string, string, number, number][] = [
      ["soldier", "SOLDATS", "S", "1", SPR.R_SOLDIER, SPR.B_SOLDIER],
      ["tank", "TANKS", "K", "2", SPR.R_TANK, SPR.B_TANK],
      ["turret", "TOUREL.", "R", "3", SPR.R_TURRET, SPR.B_TURRET],
      ["heli", "HELICOS", "L", "4", SPR.R_HELI, SPR.B_HELI],
    ];
    this.buttons = commands.map(([id, label, key, sprRed, sprBlue], k) => ({
      id,
      up: null,
      label,
      key,
      sprRed,
      sprBlue,
      x: x0 + (w + BTN_GAP) * k,
      y: commandY,
      w,
    }));
    branches.forEach(([kind, label, atkKey, defKey, sprRed, sprBlue], k) => {
      for (const stat of ["atk", "def"] as const) {
        this.buttons.push({
          id: `up:${kind}:${stat}`,
          up: { kind, stat },
          label,
          key: stat === "atk" ? atkKey : defKey,
          sprRed,
          sprBlue,
          x: x0 + (w + BTN_GAP) * k,
          y: stat === "atk" ? atkY : defY,
          w,
        });
      }
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
    // Le général distant « réfléchit » : points animés devant son nom.
    const dots = s.enemyThinking ? ".".repeat(1 + (Math.floor(this.t * 3) % 3)).padEnd(3, " ") + " " : "";
    ctx.fillText(dots + this.trunc(s.enemyName), VIEW_W - 6, 24);
    ctx.textAlign = "left";

    /* Réplique du général (niveau CLAUDE) — bulle sous la bande des noms,
       cédant la place à la bannière de mode quand le joueur en a une. */
    if (!s.mode && s.enemySay && s.enemySayAge < SAY_FOR) {
      const fade = clamp((SAY_FOR - s.enemySayAge) / 1.2, 0, 1);
      ctx.font = `12px ${FONT}`;
      const txt = `« ${s.enemySay} »`;
      const tw = Math.min(ctx.measureText(txt).width, VIEW_W - 40);
      ctx.globalAlpha = fade;
      ctx.fillStyle = "rgba(8, 20, 38, 0.82)";
      this.roundRect(ctx, VIEW_W / 2 - tw / 2 - 10, 32, tw + 20, 22, 6);
      ctx.fill();
      ctx.strokeStyle = enemyColor;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#ffe9d6";
      ctx.textAlign = "center";
      ctx.fillText(txt, VIEW_W / 2, 47, VIEW_W - 40);
      ctx.textAlign = "left";
      ctx.globalAlpha = 1;
    }

    /* Battle clock — centered at the top, between the two names (m:ss) */
    const total = Math.max(0, Math.floor(s.elapsed));
    const clock = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
    ctx.font = `11px ${FONT}`;
    const cw = ctx.measureText(clock).width;
    ctx.fillStyle = "rgba(8, 20, 38, 0.6)";
    this.roundRect(ctx, VIEW_W / 2 - cw / 2 - 7, 15, cw + 14, 15, 4);
    ctx.fill();
    ctx.fillStyle = s.suddenDeath ? "#ff8b7a" : "#ffffff";
    ctx.textAlign = "center";
    ctx.fillText(clock, VIEW_W / 2, 27);
    if (s.suddenDeath) {
      // Mort subite : rappel clignotant sous l'horloge (qui a le moins de terrain perd son QG)
      ctx.font = `9px ${FONT}`;
      ctx.globalAlpha = 0.65 + 0.35 * Math.sin(s.elapsed * 6);
      ctx.fillText("MORT SUBITE", VIEW_W / 2, 41);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = "left";

    /* Bottom panel */
    ctx.fillStyle = COLORS.hudBg;
    ctx.fillRect(0, MAP_H, VIEW_W, VIEW_H - MAP_H);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(0, MAP_H, VIEW_W, 2);

    // Gold — à gauche de la ligne des bâtiments (capped display so 4+ digits never bleed into the buttons)
    drawSprite(ctx, SPR.GOLD, 18, MAP_H + 112, 24);
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = COLORS.gold;
    const g = Math.floor(s.myGold);
    ctx.fillText(g > 99999 ? "99999+" : `${g}`, 33, MAP_H + 117);
    // My flag under the gold
    drawSprite(ctx, mine === BLUE ? SPR.B_FLAG : SPR.R_FLAG, 18, MAP_H + 132, 16);
    ctx.font = `9px ${FONT}`;
    ctx.fillStyle = "#9fc3e4";
    ctx.fillText(mine === BLUE ? "BLEU" : "ROUGE", 32, MAP_H + 136);

    // Intitulés des deux lignes d'améliorations (mêmes couleurs que les galons des unités)
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = "right";
    ctx.fillStyle = "#8fd8ff";
    ctx.fillText("DEFENSE", 104, MAP_H + 30);
    ctx.fillStyle = "#ffd95e";
    ctx.fillText("FORCE", 104, MAP_H + 76);
    ctx.textAlign = "left";

    // Mute toggle
    drawMuteIcon(ctx, MUTE_CX, MUTE_CY, MUTE_R, isMuted());

    // Buttons
    for (const b of this.buttons) {
      const isUpgrade = b.up !== null;
      let cost = 0;
      if (b.up) cost = s.upCost(b.up.kind, b.up.stat);
      else if (b.id === "barracks" || b.id === "factory" || b.id === "turret") cost = s.buildCostOf(b.id);
      else if (b.id === "strike" || b.id === "helico") cost = COST[b.id];
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
      const label = b.up ? `${b.label} ${s.upLevel(b.up.kind, b.up.stat)}` : b.label;
      ctx.fillText(label, b.x + 25, b.y + 16);
      if (cost && cost > 0) {
        ctx.fillStyle = COLORS.gold;
        ctx.font = `8px ${FONT}`;
        ctx.fillText(`${cost} or`, b.x + 25, b.y + 32);
      } else {
        ctx.fillStyle = "#bfe1ff";
        ctx.fillText("attaque", b.x + 25, b.y + 32);
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
