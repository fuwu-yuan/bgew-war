import { Board, Entities, Entity, GameStep } from "@fuwu-yuan/bgew";
import { BLUE, COLORS, FONT, GAME_VERSION, loadBest, RED, VIEW_H, VIEW_W } from "../globals";
import { formatTime, TAU } from "../utils";
import { TileMap } from "../entities/tilemap";
import { Fader } from "../entities/effects";
import { drawSprite, SPR } from "../sprites";

/** Title art drawn above the live island background. */
class MenuArt extends Entity {
  public showHelp = false;
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

    ctx.fillStyle = "rgba(6, 16, 32, 0.62)";
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Armies facing off around the title
    const bob = Math.sin(this.t * 3) * 3;
    drawSprite(ctx, SPR.R_HQ, VIEW_W / 2, 130 + bob * 0.4, 84);
    drawSprite(ctx, SPR.R_FLAG, VIEW_W / 2 + 52, 100 + bob * 0.4, 30);
    for (let i = 0; i < 5; i++) {
      drawSprite(ctx, SPR.R_SOLDIER, VIEW_W / 2 + (i - 2) * 52, 196 + Math.sin(this.t * 6 + i) * 2, 30);
      drawSprite(ctx, SPR.B_SOLDIER, VIEW_W / 2 + (i - 2) * 52, VIEW_H - 250 + Math.sin(this.t * 6 + i + 2) * 2, 30);
    }
    drawSprite(ctx, SPR.R_TANK, VIEW_W / 2 - 156, 192, 40);
    drawSprite(ctx, SPR.B_TANK, VIEW_W / 2 + 156, VIEW_H - 254, 40);
    drawSprite(ctx, SPR.B_HQ, VIEW_W / 2, VIEW_H - 180 - bob * 0.4, 84);
    drawSprite(ctx, SPR.B_FLAG, VIEW_W / 2 + 52, VIEW_H - 210 - bob * 0.4, 30);

    // Title
    ctx.textAlign = "center";
    ctx.font = `92px ${FONT}`;
    ctx.lineWidth = 10;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.strokeText("BGEW", VIEW_W / 2, 320);
    ctx.fillStyle = "#ffffff";
    ctx.fillText("BGEW", VIEW_W / 2, 320);
    ctx.font = `120px ${FONT}`;
    ctx.strokeText("WAR", VIEW_W / 2, 432);
    const grad = ctx.createLinearGradient(0, 340, 0, 440);
    grad.addColorStop(0, COLORS.redTileA);
    grad.addColorStop(1, COLORS.blueUnit);
    ctx.fillStyle = grad;
    ctx.fillText("WAR", VIEW_W / 2, 432);
    ctx.font = `17px ${FONT}`;
    ctx.fillStyle = "#bfd9f2";
    ctx.fillText("LA GUERRE DU TERRITOIRE", VIEW_W / 2, 470);

    if (this.showHelp) {
      ctx.fillStyle = COLORS.uiPanel;
      ctx.fillRect(50, 490, VIEW_W - 100, 320);
      ctx.strokeStyle = "rgba(140, 190, 235, 0.7)";
      ctx.lineWidth = 2;
      ctx.strokeRect(50, 490, VIEW_W - 100, 320);
      ctx.fillStyle = "#ffe27a";
      ctx.font = `20px ${FONT}`;
      ctx.fillText("COMMENT JOUER", VIEW_W / 2, 528);
      ctx.fillStyle = "#e8f2fc";
      ctx.font = `15px ${FONT}`;
      const lines = [
        "Vos soldats avancent tout seuls et",
        "convertissent les cases : le front bouge.",
        "L'or vient des cases prises, des coffres",
        "et des ennemis abattus.",
        "",
        "Construisez CASERNES, TOURELLES, USINES.",
        "SOLDATS+ : ameliorez vos troupes (niv 5).",
        "FRAPPE : bombardez une zone (pour tous !).",
        "AXE : concentrez l'attaque sur une colonne.",
        "",
        "Detruisez le QG ennemi pour gagner —",
        "c'est une forteresse : usez le front d'abord.",
      ];
      lines.forEach((l, k) => ctx.fillText(l, VIEW_W / 2, 560 + k * 22));
    }
    ctx.textAlign = "left";
  }
}

export class MenuStep extends GameStep {
  name = "menu";
  private starting = false;
  private art!: MenuArt;
  private soundHint: Entities.Label | null = null;

  constructor(board: Board) {
    super(board);
    board.onMouseEvent("click", () => {
      if (board.step !== this) return;
      if (this.soundHint) this.soundHint.visible = false;
    });
    board.onKeyboardEvent("keydown", (e: KeyboardEvent) => {
      if (board.step !== this || this.starting) return;
      if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space") this.startGame();
    });
  }

  onEnter(): void {
    this.starting = false;
    this.camera.x = 0;
    this.camera.y = 0;

    this.board.addEntity(new TileMap());
    this.art = new MenuArt();
    this.board.addEntity(this.art);

    const playBtn = this.makeButton(VIEW_W / 2 - 140, 504, 280, 58, "JOUER", "#ffe27a", 22);
    playBtn.onMouseEvent("click", () => this.startGame());

    const multiBtn = this.makeButton(VIEW_W / 2 - 140, 574, 280, 50, "MULTIJOUEUR", "#7fd1ff", 17);
    multiBtn.onMouseEvent("click", () => this.goLobby());

    const helpBtn = this.makeButton(VIEW_W / 2 - 140, 636, 280, 44, "COMMENT JOUER", "rgba(190, 215, 240, 0.9)", 15);
    let openingClick = false;
    helpBtn.onMouseEvent("click", () => {
      this.board.playSound("click", false, 0.4);
      this.art.showHelp = true;
      playBtn.visible = false;
      multiBtn.visible = false;
      helpBtn.visible = false;
      openingClick = true;
      setTimeout(() => (openingClick = false), 0);
    });
    // Any tap closes the help panel (the guard keeps the opening tap out)
    this.board.onMouseEvent("click", () => {
      if (this.board.step !== this || !this.art.showHelp || openingClick) return;
      this.art.showHelp = false;
      playBtn.visible = true;
      multiBtn.visible = true;
      helpBtn.visible = true;
      this.board.playSound("click", false, 0.4);
    });

    const best = loadBest();
    if (best && best.wins > 0) {
      const label = new Entities.Label(
        0,
        706,
        `VICTOIRES : ${best.wins}  —  MEILLEUR TEMPS : ${formatTime(best.bestTime)}`,
        this.board.ctx
      );
      label.fontFamily = FONT;
      label.fontSize = 14;
      label.fontColor = COLORS.gold;
      label.x = VIEW_W / 2 - label.width / 2;
      this.board.addEntity(label);
    }

    const footer = new Entities.Label(0, VIEW_H - 30, `v${GAME_VERSION} — cree avec BGEW, le Baguette Game Engine Web`, this.board.ctx);
    footer.fontFamily = FONT;
    footer.fontSize = 11;
    footer.fontColor = "rgba(190, 215, 240, 0.55)";
    footer.x = VIEW_W / 2 - footer.width / 2;
    this.board.addEntity(footer);

    this.soundHint = new Entities.Label(0, VIEW_H - 54, "touchez pour activer le son", this.board.ctx);
    this.soundHint.fontFamily = FONT;
    this.soundHint.fontSize = 11;
    this.soundHint.fontColor = "rgba(190, 215, 240, 0.6)";
    this.soundHint.x = VIEW_W / 2 - this.soundHint.width / 2;
    this.board.addEntity(this.soundHint);

    this.board.addEntity(new Fader(1, 0, 500));
  }

  onLeave(): void {
    this.soundHint = null;
  }

  private startGame(): void {
    if (this.starting) return;
    this.starting = true;
    this.board.playSound("click", false, 0.5);
    this.board.addEntity(
      new Fader(0, 1, 450, "#08111f", () => {
        this.board.moveToStep("game", {});
      })
    );
  }

  private goLobby(): void {
    if (this.starting) return;
    this.starting = true;
    this.board.playSound("click", false, 0.5);
    this.board.addEntity(
      new Fader(0, 1, 450, "#08111f", () => {
        this.board.moveToStep("lobby", {});
      })
    );
  }

  private makeButton(x: number, y: number, w: number, h: number, text: string, color: string, size: number): Entities.Button {
    const btn = new Entities.Button(x, y, w, h, text);
    btn.fontFamily = FONT;
    btn.fontSize = size;
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
