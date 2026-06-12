import { Board, Entities, Entity, GameStep } from "@fuwu-yuan/bgew";
import { BLUE, COLORS, FONT, GAME_VERSION, loadBest, RED, VIEW_H, VIEW_W } from "../globals";
import { formatTime, TAU } from "../utils";
import { TileMap } from "../entities/tilemap";
import { Fader } from "../entities/effects";
import { drawSprite, SPR } from "../sprites";
import {
  currentUser,
  displayName,
  loadLeaderboard,
  loadMyRank,
  logout,
  needsPseudo,
  onUserChange,
  setPseudo,
  signInGoogle,
  type LeaderboardEntry,
} from "../firebase";
import { track, trackScreen } from "../analytics";

/** Title art drawn above the live island background. */
class MenuArt extends Entity {
  public showHelp = false;
  public leaderboard: LeaderboardEntry[] = [];
  public authName = "";
  public authError = "";
  public soloWins = 0;
  public multiWins: number | null = null;
  public myRank: number | null = null;
  public myUid = "";
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
      ctx.fillRect(50, 490, VIEW_W - 100, 342);
      ctx.strokeStyle = "rgba(140, 190, 235, 0.7)";
      ctx.lineWidth = 2;
      ctx.strokeRect(50, 490, VIEW_W - 100, 342);
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
        "HELICO : raid aerien (anti-air : tourelles).",
        "AXE : concentrez l'attaque sur une colonne.",
        "",
        "Detruisez le QG ennemi pour gagner —",
        "c'est une forteresse : usez le front d'abord.",
      ];
      lines.forEach((l, k) => ctx.fillText(l, VIEW_W / 2, 560 + k * 22));
    }

    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(10, 25, 45, 0.72)";
    ctx.fillRect(50, 690, VIEW_W - 100, 184);
    ctx.strokeStyle = "rgba(140, 190, 235, 0.45)";
    ctx.lineWidth = 2;
    ctx.strokeRect(50, 690, VIEW_W - 100, 184);
    ctx.font = `15px ${FONT}`;
    ctx.fillStyle = COLORS.gold;
    ctx.fillText("CLASSEMENT MULTI", 70, 722);
    ctx.textAlign = "right";
    ctx.fillStyle = this.authName ? "#9fc3e4" : "#ffb13d";
    ctx.font = `11px ${FONT}`;
    ctx.fillText(this.authName ? this.authName : "non connecte", VIEW_W - 70, 721);
    ctx.textAlign = "left";
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = "#e8f2fc";
    if (this.myRank !== null && this.multiWins !== null) {
      ctx.fillStyle = COLORS.gold;
      ctx.fillText(`Votre place : #${this.myRank} avec ${this.multiWins} victoire${this.multiWins > 1 ? "s" : ""}`, 70, 744);
    }
    if (this.leaderboard.length === 0) {
      ctx.fillStyle = "#e8f2fc";
      ctx.fillText("Aucune victoire multi enregistree.", 70, 768);
    } else {
      this.leaderboard.slice(0, 5).forEach((e, i) => {
        const y = 766 + i * 20;
        const mine = e.uid === this.myUid;
        if (mine) {
          ctx.fillStyle = "rgba(255, 217, 94, 0.18)";
          ctx.fillRect(62, y - 15, VIEW_W - 124, 19);
        }
        ctx.fillStyle = mine || i === 0 ? COLORS.gold : "#e8f2fc";
        ctx.fillText(`${i + 1}. ${e.name}`, 70, y);
        ctx.textAlign = "right";
        ctx.fillText(`${e.wins} V`, VIEW_W - 128, y);
        ctx.fillText(e.bestTime ? formatTime(e.bestTime) : "--", VIEW_W - 70, y);
        ctx.textAlign = "left";
      });
    }
    if (this.authError) {
      ctx.fillStyle = "#ff8b7a";
      ctx.font = `10px ${FONT}`;
      ctx.fillText(this.authError, 70, 862);
    }
    ctx.textAlign = "center";
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = COLORS.gold;
    const stats =
      this.multiWins === null
        ? `VICTOIRES SOLO : ${this.soloWins}`
        : `VICTOIRES SOLO : ${this.soloWins}  |  VICTOIRES MULTI : ${this.multiWins}`;
    ctx.fillText(stats, VIEW_W / 2, 940);
    ctx.textAlign = "left";
  }
}

export class MenuStep extends GameStep {
  name = "menu";
  private starting = false;
  private art!: MenuArt;
  private soundHint: Entities.Label | null = null;
  private unsubAuth: (() => void) | null = null;
  private logoutBtn: Entities.Button | null = null;

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
    trackScreen("menu");

    this.board.addEntity(new TileMap());
    this.art = new MenuArt();
    this.art.soloWins = loadBest()?.wins ?? 0;
    this.board.addEntity(this.art);
    this.refreshAccount();
    this.refreshLeaderboard();
    this.unsubAuth = onUserChange(() => {
      this.refreshAccount();
      this.refreshLeaderboard();
    });

    const playBtn = this.makeButton(VIEW_W / 2 - 140, 504, 280, 58, "JOUER", "#ffe27a", 22);
    playBtn.onMouseEvent("click", () => this.startGame());

    const multiBtn = this.makeButton(VIEW_W / 2 - 140, 574, 280, 50, "MULTIJOUEUR", "#7fd1ff", 17);
    multiBtn.onMouseEvent("click", () => this.goLobby());

    const helpBtn = this.makeButton(VIEW_W / 2 - 140, 636, 280, 44, "COMMENT JOUER", "rgba(190, 215, 240, 0.9)", 15);
    let openingClick = false;
    helpBtn.onMouseEvent("click", () => {
      this.board.playSound("click", false, 0.4);
      track("help_opened");
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

    const googleBtn = this.makeButton(VIEW_W / 2 - 140, 884, 280, 34, "CONNEXION GOOGLE", "#7fd1ff", 10);
    googleBtn.onMouseEvent("click", () => {
      track("login", { method: "google" });
      this.authAction(() => this.signInGoogleWithPseudo());
    });
    this.logoutBtn = this.makeButton(VIEW_W / 2 + 152, 884, 118, 34, "LOGOUT", "rgba(190, 215, 240, 0.9)", 11);
    this.logoutBtn.onMouseEvent("click", () => {
      track("logout");
      this.authAction(() => logout());
    });
    this.refreshAccount();

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
    this.unsubAuth?.();
    this.unsubAuth = null;
  }

  private refreshAccount(): void {
    const user = currentUser();
    this.art.authName = user ? (user.isAnonymous ? "invite" : displayName(user)) : "invite";
    this.art.myUid = user && !user.isAnonymous ? user.uid : "";
    if (!this.art.myUid) {
      this.art.multiWins = null;
      this.art.myRank = null;
    }
    if (this.logoutBtn) this.logoutBtn.visible = !!user && !user.isAnonymous;
  }

  private refreshLeaderboard(): void {
    Promise.all([loadLeaderboard(10), loadMyRank()])
      .then(([rows, rank]) => {
        if (this.art) this.art.leaderboard = rows;
        if (this.art) {
          this.art.multiWins = rank?.entry.wins ?? null;
          this.art.myRank = rank?.rank ?? null;
        }
      })
      .catch(() => {
        if (this.art) this.art.authError = "classement indisponible";
      });
  }

  private authAction(fn: () => Promise<unknown>): void {
    this.board.playSound("click", false, 0.4);
    this.art.authError = "";
    fn()
      .then(() => {
        this.refreshAccount();
        this.refreshLeaderboard();
      })
      .catch((err) => {
        this.art.authError = String(err?.code || err?.message || "connexion impossible").slice(0, 48);
      });
  }

  private async signInGoogleWithPseudo(): Promise<void> {
    const user = await signInGoogle();
    if (!(await needsPseudo(user))) return;
    const chosen = window.prompt("Choisissez votre pseudo pour le classement", displayName(user));
    await setPseudo(chosen || displayName(user), user);
    track("set_pseudo");
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
    track("multiplayer_open");
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
