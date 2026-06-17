import { Board, Entities, Entity, GameStep } from "@fuwu-yuan/bgew";
import { BLUE, COLORS, FONT, loadBest, RED, saveBest, VIEW_H, VIEW_W } from "../globals";
import { formatTime, TAU } from "../utils";
import { Fader } from "../entities/effects";
import { drawSprite, SPR } from "../sprites";
import { currentUser, displayName, profileName, signInGoogleWithPseudo, submitMatchResult } from "../firebase";
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
  /** Anti-cheat: false → the result is NOT recorded to the leaderboard. */
  ranked?: boolean;
  /** The match was cancelled (e.g. inactive opponent) → neutral end screen. */
  voided?: boolean;
  /** Why the match is unranked / void (shown to the player). */
  reason?: string;
  /** Shared match id + opponent uid, for the ranked-validation Cloud Function. */
  matchId?: string;
  enemyUid?: string;
}

/** Result screen art (background + banner + stats). */
class EndArt extends Entity {
  private data: EndData;
  public accountMsg = "";
  public accountError = "";
  public connected = false;
  public playerName = "";
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

    const voided = !!d.voided;
    const grad = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    grad.addColorStop(0, voided ? "#14233a" : d.win ? "#0c2b4a" : "#3a1020");
    grad.addColorStop(1, "#08111f");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Always the PLAYER's own HQ: intact and flying high on a win, a burning
    // wreck on a loss, and intact-but-neutral for a cancelled match.
    const mineBlue = (d.faction ?? BLUE) === BLUE;
    const bob = Math.sin(this.t * 3) * 4;
    if (voided) {
      drawSprite(ctx, mineBlue ? SPR.B_HQ : SPR.R_HQ, VIEW_W / 2, 200 + bob, 110);
    } else if (d.win) {
      drawSprite(ctx, mineBlue ? SPR.B_HQ : SPR.R_HQ, VIEW_W / 2, 200 + bob, 110);
      drawSprite(ctx, mineBlue ? SPR.B_FLAG : SPR.R_FLAG, VIEW_W / 2 + 66, 160 + bob, 40);
    } else {
      this.drawWreck(ctx, mineBlue);
    }

    ctx.textAlign = "center";
    if (voided) {
      ctx.font = `44px ${FONT}`;
      ctx.lineWidth = 7;
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.strokeText("PARTIE ANNULEE", VIEW_W / 2, 332);
      ctx.fillStyle = "#ffe27a";
      ctx.fillText("PARTIE ANNULEE", VIEW_W / 2, 332);
    } else {
      ctx.font = `72px ${FONT}`;
      ctx.lineWidth = 9;
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      const title = d.win ? "VICTOIRE !" : "DEFAITE";
      ctx.strokeText(title, VIEW_W / 2, 340);
      ctx.fillStyle = d.win ? "#7fd1ff" : "#ff7a6b";
      ctx.fillText(title, VIEW_W / 2, 340);
    }

    ctx.font = `16px ${FONT}`;
    ctx.fillStyle = "#e8f2fc";
    const sub = voided
      ? d.reason || "Match non comptabilise."
      : d.win
        ? "Le QG ennemi est tombe. L'ile est a vous."
        : "Votre QG est tombe. L'ile est perdue.";
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
      const unranked = d.ranked === false;
      // The panel grows to three lines when the pseudo line is shown.
      const threeLines = !unranked && this.connected && !!this.playerName;
      const boxY = 612;
      const boxH = threeLines ? 86 : 64;
      ctx.fillStyle = "rgba(10, 25, 45, 0.78)";
      ctx.fillRect(100, boxY, VIEW_W - 200, boxH);
      ctx.strokeStyle = unranked ? "rgba(255, 177, 61, 0.55)" : "rgba(140, 190, 235, 0.45)";
      ctx.lineWidth = 2;
      ctx.strokeRect(100, boxY, VIEW_W - 200, boxH);

      const l1 = boxY + 26;
      const l2 = boxY + 48;
      const l3 = boxY + 70;

      // Unranked / cancelled: nothing is recorded, just say why.
      if (unranked) {
        ctx.textAlign = "center";
        ctx.font = `13px ${FONT}`;
        ctx.fillStyle = "#ffb13d";
        ctx.fillText("Partie non classee", VIEW_W / 2, l1);
        ctx.font = `12px ${FONT}`;
        ctx.fillStyle = "#e8f2fc";
        ctx.fillText(d.reason || "Ce match ne compte pas pour le classement.", VIEW_W / 2, l2);
        ctx.textAlign = "left";
        return;
      }

      const saved = this.connected && !this.accountError && this.accountMsg === "Stats multi enregistrees.";
      ctx.textAlign = "center";
      ctx.font = `12px ${FONT}`;
      const msg = this.accountError || this.accountMsg;
      ctx.fillStyle = this.accountError ? "#ff8b7a" : "#9fc3e4";
      ctx.fillText(msg, VIEW_W / 2, l1);

      // Green validation check, only once the multi stats are recorded
      if (saved) {
        const checkX = VIEW_W / 2 - ctx.measureText(msg).width / 2 - 16;
        ctx.fillStyle = "#5dde6a";
        ctx.font = `15px ${FONT}`;
        ctx.fillText("✓", checkX, l1 + 1);
        ctx.font = `12px ${FONT}`;
      }

      ctx.fillStyle = "#e8f2fc";
      if (this.connected) {
        ctx.fillText("Vos stats multi sont liees a votre compte.", VIEW_W / 2, l2);
        if (this.playerName) {
          ctx.fillStyle = "#9fc3e4";
          ctx.fillText(`Connecte : ${this.playerName}`, VIEW_W / 2, l3);
        }
      } else {
        ctx.fillText("Connectez Google pour cumuler vos victoires et stats multi.", VIEW_W / 2, l2);
      }
      ctx.textAlign = "left";
    }
  }

  /** A burning, listing wreck of the player's own HQ, shown on a loss. */
  private drawWreck(ctx: CanvasRenderingContext2D, mineBlue: boolean): void {
    const t = this.t;
    const cx = VIEW_W / 2;
    const cy = 205;

    // Heat glow behind the ruin
    const glow = ctx.createRadialGradient(cx, cy + 6, 8, cx, cy + 6, 130);
    glow.addColorStop(0, "rgba(255, 120, 55, 0.45)");
    glow.addColorStop(1, "rgba(255, 120, 55, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(cx - 140, cy - 130, 280, 280);

    // Smoke billowing up from the rubble (looping puffs)
    for (let i = 0; i < 6; i++) {
      const ph = (t * 0.32 + i / 6) % 1;
      const sy = cy - 24 - ph * 130;
      const sx = cx + Math.sin(t * 1.4 + i * 1.7) * 20 + (i - 2.5) * 7;
      const r = 12 + ph * 36;
      ctx.globalAlpha = (1 - ph) * 0.4;
      ctx.fillStyle = i % 2 ? "#3a3f47" : "#4a4036";
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // The HQ + its flames share ONE tilted/wobbling transform, so the fire at
    // the base follows the building's orientation instead of staying flat.
    ctx.save();
    ctx.translate(cx, cy + 14);
    ctx.rotate(((8 + Math.sin(t * 2) * 1.2) * Math.PI) / 180);
    drawSprite(ctx, mineBlue ? SPR.B_HQ : SPR.R_HQ, 0, 0, 104);
    ctx.fillStyle = "rgba(20, 12, 8, 0.42)"; // scorch
    ctx.fillRect(-52, -52, 104, 104);
    // Flames licking the base, in LOCAL space → they tilt with the wreck.
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 8; i++) {
      const fx = -56 + i * 16;
      const h = 20 + Math.sin(t * 11 + i * 1.5) * 10 + Math.sin(t * 23 + i) * 4;
      this.flame(ctx, fx, 46, 16, h);
    }
    ctx.restore();
  }

  /** A single gradient flame tongue rising from (x, baseY). */
  private flame(ctx: CanvasRenderingContext2D, x: number, baseY: number, w: number, h: number): void {
    const g = ctx.createLinearGradient(0, baseY - h, 0, baseY);
    g.addColorStop(0, "rgba(255, 80, 25, 0)");
    g.addColorStop(0.45, "rgba(255, 120, 35, 0.85)");
    g.addColorStop(0.8, "rgba(255, 205, 70, 0.9)");
    g.addColorStop(1, "rgba(255, 245, 180, 0.95)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, baseY);
    ctx.quadraticCurveTo(x - w / 2, baseY - h * 0.6, x, baseY - h);
    ctx.quadraticCurveTo(x + w / 2, baseY - h * 0.6, x + w / 2, baseY);
    ctx.closePath();
    ctx.fill();
  }
}

export class EndStep extends GameStep {
  name = "end";
  private leaving = false;
  private art!: EndArt;
  private pendingData: EndData | null = null;
  private loginBtn: Entities.Button | null = null;
  private multiBtns: Entities.Button[] = [];

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
    // Anti-cheat: an unranked/cancelled match is never recorded or scored.
    const ranked = !!data.multi && data.ranked !== false;
    // GA4 leaderboard convention: only ranked multiplayer wins post a score.
    if (ranked && data.win) track("post_score", { score: Math.round(data.time), level: "multi" });

    // Multiplayer: the room is over, hang up cleanly
    if (data.multi) this.board.networkManager.leaveRoom();

    if (data.win && !data.multi) {
      const best = loadBest() ?? { wins: 0, bestTime: Infinity };
      saveBest({
        wins: best.wins + 1,
        bestTime: Math.min(best.bestTime ?? Infinity, data.time),
      });
    }
    this.pendingData = ranked ? data : null;

    this.art = new EndArt(data);
    this.board.addEntity(this.art);

    const user = currentUser();
    const connected = !!user && !user.isAnonymous;
    if (connected) {
      this.art.connected = true;
      this.art.playerName = displayName(user!); // placeholder until the pseudo loads
      profileName(user!).then((n) => { if (this.art) this.art.playerName = n; });
    }
    if (ranked && connected) {
      this.art.accountMsg = "Stats multi enregistrees.";
      this.saveMultiResult(data);
    } else if (ranked) {
      this.art.accountMsg = "Invite : connectez Google pour garder vos stats.";
    }

    if (data.multi) {
      // The opponent is gone with the room: back to the lobby or the menu.
      // The Google button only appears when there's actually a result to save.
      let y = 704;
      if (!connected && ranked) {
        this.loginBtn = this.makeButton(VIEW_W / 2 - 140, y, "CONNEXION GOOGLE", "#ffe27a");
        this.loginBtn.onMouseEvent("click", () => this.connectGoogle());
        y += 62;
      }
      const lobby = this.makeButton(VIEW_W / 2 - 140, y, "RETOUR AU LOBBY", "#7fd1ff");
      lobby.onMouseEvent("click", () => this.goTo("lobby"));
      y += 62;
      const menu = this.makeButton(VIEW_W / 2 - 140, y, "MENU", "rgba(190, 215, 240, 0.9)");
      menu.onMouseEvent("click", () => this.goTo("menu"));
      this.multiBtns = [lobby, menu];
    } else {
      const replay = this.makeButton(VIEW_W / 2 - 140, 660, "REJOUER", "#ffe27a");
      replay.onMouseEvent("click", () => {
        track("replay");
        this.goTo("game");
      });
      const menu = this.makeButton(VIEW_W / 2 - 140, 736, "MENU", "rgba(190, 215, 240, 0.9)");
      menu.onMouseEvent("click", () => this.goTo("menu"));
    }

    this.board.addEntity(new Fader(1, 0, 600));
  }

  onLeave(): void {}

  private saveMultiResult(data: EndData, attempt = 0): void {
    if (!data.matchId || !data.enemyUid) {
      if (this.art) this.art.accountError = "Stats non enregistrees (adversaire).";
      return;
    }
    if (this.art && attempt === 0) this.art.accountMsg = "Envoi des stats...";
    submitMatchResult({
      matchId: data.matchId,
      opponentUid: data.enemyUid,
      win: data.win,
      time: data.time,
      share: data.share,
      kills: data.kills,
      losses: data.losses,
      faction: data.faction ?? BLUE,
    })
      .then((out) => {
        if (!this.art) return;
        if (out.status === "resolved") {
          this.art.accountMsg = "Stats multi enregistrees.";
        } else if (out.status === "disputed") {
          this.art.accountError = "Resultat refuse (controle anti-triche).";
        } else if (attempt < 3) {
          // Still waiting on the opponent's report — poll the function again.
          this.art.accountMsg = "Validation en cours...";
          this.addTimer(2500, () => this.saveMultiResult(data, attempt + 1), false);
        } else {
          this.art.accountError = "Adversaire n'a pas confirme — non classe.";
        }
      })
      .catch((err) => {
        console.warn("match submit failed", err);
        if (this.art) this.art.accountError = "Impossible d'enregistrer les stats.";
      });
  }

  private connectGoogle(): void {
    if (!this.pendingData) return;
    track("login", { method: "google" });
    this.board.playSound("click", false, 0.5);
    this.art.accountError = "";
    this.art.accountMsg = "Connexion Google...";
    signInGoogleWithPseudo()
      .then(({ name, asked }) => {
        if (asked) track("set_pseudo");
        this.art.connected = true;
        this.art.playerName = name;
        if (this.loginBtn) {
          this.loginBtn.visible = false;
          this.loginBtn.disabled = true;
          this.board.removeEntity(this.loginBtn);
          this.loginBtn = null;
          // Close the gap left by the login button: pull the remaining buttons up.
          this.multiBtns.forEach((b) => (b.y -= 62));
        }
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
