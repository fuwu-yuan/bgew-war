import { Board, Entities, Entity, GameStep } from "@fuwu-yuan/bgew";
import { BLUE, COLORS, FONT, loadBest, RED, saveBest, VIEW_H, VIEW_W } from "../globals";
import { formatTime } from "../utils";
import { Fader } from "../entities/effects";
import { drawSprite, SPR } from "../sprites";
import { currentUser, recordMultiResult, signInGoogle } from "../firebase";
import { track, trackScreen } from "../analytics";

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
  public accountMsg = "";
  public accountError = "";
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

    if (d.multi) {
      ctx.fillStyle = "rgba(10, 25, 45, 0.78)";
      ctx.fillRect(100, 620, VIEW_W - 200, 70);
      ctx.strokeStyle = "rgba(140, 190, 235, 0.45)";
      ctx.lineWidth = 2;
      ctx.strokeRect(100, 620, VIEW_W - 200, 70);
      ctx.textAlign = "center";
      ctx.font = `12px ${FONT}`;
      ctx.fillStyle = this.accountError ? "#ff8b7a" : "#9fc3e4";
      ctx.fillText(this.accountError || this.accountMsg, VIEW_W / 2, 648);
      ctx.fillStyle = "#e8f2fc";
      ctx.fillText("Connectez Google pour cumuler victoires et stats multi.", VIEW_W / 2, 672);
      ctx.textAlign = "left";
    }
  }
}

export class EndStep extends GameStep {
  name = "end";
  private leaving = false;
  private art!: EndArt;
  private pendingData: EndData | null = null;

  constructor(board: Board) {
    super(board);
  }

  onEnter(data: EndData): void {
    this.leaving = false;
    this.camera.x = 0;
    this.camera.y = 0;

    trackScreen("end");
    const mode = data.multi ? (data.faction === RED ? "guest" : "host") : "solo";
    track("game_end", {
      mode,
      result: data.win ? "win" : "loss",
      faction: data.faction === RED ? "red" : "blue",
      duration: Math.round(data.time),
      share: Math.round(data.share * 100),
      kills: data.kills,
      losses: data.losses,
    });
    // GA4 leaderboard convention: only ranked multiplayer wins post a score.
    if (data.multi && data.win) track("post_score", { score: Math.round(data.time), level: "multi" });

    // Multiplayer: the room is over, hang up cleanly
    if (data.multi) this.board.networkManager.leaveRoom();

    if (data.win && !data.multi) {
      const best = loadBest() ?? { wins: 0, bestTime: Infinity };
      saveBest({
        wins: best.wins + 1,
        bestTime: Math.min(best.bestTime ?? Infinity, data.time),
      });
    }
    this.pendingData = data.multi ? data : null;

    this.art = new EndArt(data);
    this.board.addEntity(this.art);

    const user = currentUser();
    if (data.multi && user) {
      this.art.accountMsg = "Stats multi enregistrees.";
      this.saveMultiResult(data);
    } else if (data.multi) {
      this.art.accountMsg = "Invite : connectez Google pour garder vos stats.";
    }

    if (data.multi) {
      // The opponent is gone with the room: back to the lobby or the menu
      const login = this.makeButton(VIEW_W / 2 - 140, 704, "CONNECTER GOOGLE", "#ffe27a");
      login.onMouseEvent("click", () => this.connectGoogle());
      const lobby = this.makeButton(VIEW_W / 2 - 140, 766, "RETOUR AU LOBBY", "#7fd1ff");
      lobby.onMouseEvent("click", () => this.goTo("lobby"));
    } else {
      const replay = this.makeButton(VIEW_W / 2 - 140, 660, "REJOUER", "#ffe27a");
      replay.onMouseEvent("click", () => {
        track("replay");
        this.goTo("game");
      });
    }
    const menu = this.makeButton(VIEW_W / 2 - 140, data.multi ? 828 : 736, "MENU", "rgba(190, 215, 240, 0.9)");
    menu.onMouseEvent("click", () => this.goTo("menu"));

    this.board.addEntity(new Fader(1, 0, 600));
  }

  onLeave(): void {}

  private saveMultiResult(data: EndData): void {
    recordMultiResult({
      win: data.win,
      time: data.time,
      share: data.share,
      kills: data.kills,
      losses: data.losses,
      faction: data.faction ?? BLUE,
    })
      .then(() => {
        if (this.art) this.art.accountMsg = "Stats multi enregistrees.";
      })
      .catch((err) => {
        console.warn("leaderboard update failed", err);
        if (this.art) this.art.accountError = "Impossible d'enregistrer les stats.";
      });
  }

  private connectGoogle(): void {
    if (!this.pendingData) return;
    track("login", { method: "google" });
    this.board.playSound("click", false, 0.5);
    this.art.accountError = "";
    this.art.accountMsg = "Connexion Google...";
    signInGoogle()
      .then(() => {
        if (this.pendingData) this.saveMultiResult(this.pendingData);
      })
      .catch((err) => {
        this.art.accountError = String(err?.code || err?.message || "connexion impossible").slice(0, 54);
      });
  }

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
