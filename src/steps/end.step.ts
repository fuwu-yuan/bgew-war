import { Board, Entities, Entity, GameStep } from "@fuwu-yuan/bgew";
import { BLUE, COLORS, FONT, loadBest, saveBest, VIEW_H, VIEW_W } from "../globals";
import { formatTime } from "../utils";
import { Fader } from "../entities/effects";
import { drawSprite, SPR } from "../sprites";

interface EndData {
  win: boolean;
  time: number;
  share: number;
  kills: number;
  losses: number;
  multi?: boolean;
  /** The player's faction (BLUE in solo, RED for the multiplayer guest) */
  faction?: number;
}

/** Result screen art (background + banner + stats). */
class EndArt extends Entity {
  private data: EndData;
  private t = 0;

  constructor(data: EndData) {
    super(0, 0, VIEW_W, VIEW_H);
    this.disabled = true;
    this.data = data;
  }

  update(delta: number): void {
    this.t += Math.min(delta, 50) / 1000;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);
    const d = this.data;

    const grad = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    grad.addColorStop(0, d.win ? "#0c2b4a" : "#3a1020");
    grad.addColorStop(1, "#08111f");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    const bob = Math.sin(this.t * 3) * 4;
    // Show the winner's HQ, whatever side the player was on
    const mineBlue = (d.faction ?? BLUE) === BLUE;
    const winnerBlue = d.win ? mineBlue : !mineBlue;
    drawSprite(ctx, winnerBlue ? SPR.B_HQ : SPR.R_HQ, VIEW_W / 2, 200 + bob, 110);
    drawSprite(ctx, winnerBlue ? SPR.B_FLAG : SPR.R_FLAG, VIEW_W / 2 + 66, 160 + bob, 40);

    ctx.textAlign = "center";
    ctx.font = `72px ${FONT}`;
    ctx.lineWidth = 9;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    const title = d.win ? "VICTOIRE !" : "DEFAITE";
    ctx.strokeText(title, VIEW_W / 2, 340);
    ctx.fillStyle = d.win ? "#7fd1ff" : "#ff7a6b";
    ctx.fillText(title, VIEW_W / 2, 340);

    ctx.font = `16px ${FONT}`;
    ctx.fillStyle = "#e8f2fc";
    const sub = d.win ? "Le QG ennemi est tombe. L'ile est a vous." : "Votre QG est tombe. L'ile est perdue.";
    ctx.fillText(sub, VIEW_W / 2, 384);

    const stats: [string, string][] = [
      ["DUREE DE LA GUERRE", formatTime(d.time)],
      ["TERRITOIRE FINAL", `${Math.round(d.share * 100)}%`],
      ["ENNEMIS ABATTUS", `${d.kills}`],
      ["VOS PERTES", `${d.losses}`],
    ];
    ctx.fillStyle = COLORS.uiPanel;
    ctx.fillRect(120, 430, VIEW_W - 240, 178);
    ctx.strokeStyle = "rgba(140, 190, 235, 0.5)";
    ctx.lineWidth = 2;
    ctx.strokeRect(120, 430, VIEW_W - 240, 178);
    stats.forEach(([k, v], i) => {
      const y = 468 + i * 36;
      ctx.textAlign = "left";
      ctx.font = `13px ${FONT}`;
      ctx.fillStyle = "#9fc3e4";
      ctx.fillText(k, 145, y);
      ctx.textAlign = "right";
      ctx.font = `17px ${FONT}`;
      ctx.fillStyle = COLORS.gold;
      ctx.fillText(v, VIEW_W - 145, y);
    });
    ctx.textAlign = "left";
  }
}

export class EndStep extends GameStep {
  name = "end";
  private leaving = false;

  constructor(board: Board) {
    super(board);
  }

  onEnter(data: EndData): void {
    this.leaving = false;
    this.camera.x = 0;
    this.camera.y = 0;

    // Multiplayer: the room is over, hang up cleanly
    if (data.multi) this.board.networkManager.leaveRoom();

    if (data.win && !data.multi) {
      const best = loadBest() ?? { wins: 0, bestTime: Infinity };
      saveBest({
        wins: best.wins + 1,
        bestTime: Math.min(best.bestTime ?? Infinity, data.time),
      });
    }

    this.board.addEntity(new EndArt(data));

    if (data.multi) {
      // The opponent is gone with the room: back to the lobby or the menu
      const lobby = this.makeButton(VIEW_W / 2 - 140, 660, "RETOUR AU LOBBY", "#7fd1ff");
      lobby.onMouseEvent("click", () => this.goTo("lobby"));
    } else {
      const replay = this.makeButton(VIEW_W / 2 - 140, 660, "REJOUER", "#ffe27a");
      replay.onMouseEvent("click", () => this.goTo("game"));
    }
    const menu = this.makeButton(VIEW_W / 2 - 140, 736, "MENU", "rgba(190, 215, 240, 0.9)");
    menu.onMouseEvent("click", () => this.goTo("menu"));

    this.board.addEntity(new Fader(1, 0, 600));
  }

  onLeave(): void {}

  private goTo(step: string): void {
    if (this.leaving) return;
    this.leaving = true;
    this.board.playSound("click", false, 0.5);
    this.board.addEntity(
      new Fader(0, 1, 450, "#08111f", () => {
        this.board.moveToStep(step, {});
      })
    );
  }

  private makeButton(x: number, y: number, text: string, color: string): Entities.Button {
    const btn = new Entities.Button(x, y, 280, 56, text);
    btn.fontFamily = FONT;
    btn.fontSize = 18;
    btn.fontColor = "#ffffff";
    btn.strokeColor = color;
    btn.fillColor = "rgba(10, 25, 45, 0.75)";
    btn.hoverFillColor = "rgba(90, 160, 230, 0.3)";
    btn.hoverStrokeColor = "#ffe27a";
    btn.hoverFontColor = "#ffffff";
    btn.clickFillColor = "rgba(90, 160, 230, 0.5)";
    btn.clickStrokeColor = "#ffe27a";
    btn.radius = { tl: 10, tr: 10, br: 10, bl: 10 };
    btn.hoverCursor = "pointer";
    this.board.addEntity(btn);
    return btn;
  }
}
