import { Board, Entities, Entity, GameStep } from "@fuwu-yuan/bgew";
import { BLUE, COLORS, FONT, GAME_VERSION, loadBest, RED, VIEW_H, VIEW_W } from "../globals";
import { clamp, formatTime, TAU } from "../utils";
import { TileMap } from "../entities/tilemap";
import { Fader } from "../entities/effects";
import { drawSprite, SPR } from "../sprites";
import {
  cachedMenuData,
  currentUser,
  loadLeaderboard,
  loadMyRank,
  logout,
  onUserChange,
  profileName,
  signInGoogleWithPseudo,
  type LeaderboardEntry,
} from "../firebase";
import { track, trackScreen } from "../analytics";
import { audioReady, drawMuteIcon, isMuted, toggleMute } from "../sound";
import { openStatsModal } from "../entities/stats-modal";

/** Mute toggle — top-right corner of the menu. */
const MUTE_R = 16;
const MUTE_CX = VIEW_W - 30;
const MUTE_CY = 34;

/* ------------------------------------------------------------------ *
 * "Comment jouer" modal — a scrollable help panel with a close cross.
 * Geometry lives here so MenuArt (draw) and MenuStep (input) agree.
 * ------------------------------------------------------------------ */
const HELP_X = 44;
const HELP_Y = 108;
const HELP_W = VIEW_W - 88; // 552
const HELP_H = 752; // bottom = 860, clears the auth buttons row
const HELP_TITLE = 54; // title-bar height
const HELP_CX = HELP_X + 24; // content left
const HELP_CY = HELP_Y + HELP_TITLE; // content top
const HELP_CH = HELP_H - HELP_TITLE - 18; // visible content height
const HELP_CLOSE = 30; // close-cross hit size
const HEAD_ADV = 34;
const BODY_ADV = 21;
const SPACER_ADV = 10;

type HelpLine = ["h" | "b" | "s", string];
const HELP_LINES: HelpLine[] = [
  ["h", "LE PRINCIPE"],
  ["b", "Vos soldats avancent seuls et"],
  ["b", "convertissent les cases : le front"],
  ["b", "bouge sans arret. Detruisez le QG"],
  ["b", "ennemi pour gagner la guerre."],
  ["s", ""],
  ["h", "L'OR"],
  ["b", "Gagne avec les cases prises, les"],
  ["b", "coffres et les ennemis abattus."],
  ["b", "Sert a tout produire et ameliorer."],
  ["s", ""],
  ["h", "LES BATIMENTS"],
  ["b", "CASERNE (C) : produit des soldats."],
  ["b", "TOURELLE (T) : defense + anti-air."],
  ["b", "USINE (U) : produit des tanks."],
  ["b", "Construisez sur vos cases libres."],
  ["s", ""],
  ["h", "LES AMELIORATIONS"],
  ["b", "SOLDATS (S), TOURELLES (R) et"],
  ["b", "TANKS (K) : montez les niveaux,"],
  ["b", "sans limite, pour des unites plus"],
  ["b", "solides et plus puissantes."],
  ["s", ""],
  ["h", "LES POUVOIRS"],
  ["b", "FRAPPE (F) : bombarde une zone."],
  ["b", "Touche TOUT, vos troupes comprises"],
  ["b", "— visez bien !"],
  ["b", "HELICO (H) : raid aerien. Seules"],
  ["b", "les tourelles et le QG l'abattent."],
  ["b", "AXE (A) : concentre l'attaque sur"],
  ["b", "une colonne de votre choix."],
  ["s", ""],
  ["h", "CONSEILS"],
  ["b", "Le QG est une forteresse : usez le"],
  ["b", "front ennemi avant de l'assaillir."],
  ["b", "Gardez des tourelles pres du QG."],
  ["b", "Echap annule le mode en cours."],
  ["b", "Les raccourcis clavier sont notes"],
  ["b", "sur chaque bouton du jeu."],
  ["s", ""],
  ["h", "MULTIJOUEUR"],
  ["b", "Connectez-vous avec Google pour"],
  ["b", "cumuler vos victoires et grimper"],
  ["b", "au classement en ligne."],
];
const HELP_TOTAL = HELP_LINES.reduce(
  (h, [k]) => h + (k === "h" ? HEAD_ADV : k === "s" ? SPACER_ADV : BODY_ADV),
  0
);
const HELP_MAX_SCROLL = Math.max(0, HELP_TOTAL - HELP_CH);
const closeX = HELP_X + HELP_W - HELP_CLOSE - 12;
const closeY = HELP_Y + 12;

/** Title art drawn above the live island background. */
class MenuArt extends Entity {
  public showHelp = false;
  public helpScroll = 0;
  public leaderboard: LeaderboardEntry[] = [];
  public authName = "";
  public authReady = false; // hold the label blank until auth + pseudo resolve
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

    // The help modal owns the screen while open — draw it and stop, so the
    // leaderboard and the solo/multi stats can't bleed through.
    if (this.showHelp) {
      this.drawHelp(ctx);
      ctx.textAlign = "left";
      return;
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
    // Only paint the label once it's settled — no "invite → Google name →
    // pseudo" flicker while auth restores and the pseudo loads.
    if (this.authReady) {
      const connected = !!this.authName && this.authName !== "invite";
      ctx.textAlign = "right";
      ctx.fillStyle = connected ? "#9fc3e4" : "#ffb13d";
      ctx.font = `11px ${FONT}`;
      ctx.fillText(connected ? this.authName : "invite", VIEW_W - 70, 721);
    }
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

    // Mute toggle (normal menu only — the help modal covers this corner)
    drawMuteIcon(ctx, MUTE_CX, MUTE_CY, MUTE_R, isMuted());
  }

  /** Scrollable "Comment jouer" modal with a close cross. */
  private drawHelp(ctx: CanvasRenderingContext2D): void {
    // Dim the whole scene behind the modal
    ctx.fillStyle = "rgba(6, 16, 32, 0.55)";
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Panel
    ctx.fillStyle = COLORS.uiPanel;
    ctx.fillRect(HELP_X, HELP_Y, HELP_W, HELP_H);
    ctx.strokeStyle = "rgba(140, 190, 235, 0.7)";
    ctx.lineWidth = 2;
    ctx.strokeRect(HELP_X, HELP_Y, HELP_W, HELP_H);

    // Title + divider
    ctx.textAlign = "center";
    ctx.font = `22px ${FONT}`;
    ctx.fillStyle = "#ffe27a";
    ctx.fillText("COMMENT JOUER", VIEW_W / 2, HELP_Y + 38);
    ctx.strokeStyle = "rgba(140, 190, 235, 0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(HELP_X + 16, HELP_Y + HELP_TITLE - 6);
    ctx.lineTo(HELP_X + HELP_W - 16, HELP_Y + HELP_TITLE - 6);
    ctx.stroke();

    // Close cross (top-right)
    const cc = closeX + HELP_CLOSE / 2;
    const cm = closeY + HELP_CLOSE / 2;
    ctx.beginPath();
    ctx.arc(cc, cm, HELP_CLOSE / 2, 0, TAU);
    ctx.fillStyle = "rgba(255, 100, 90, 0.28)";
    ctx.fill();
    ctx.strokeStyle = "#ff8b7a";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cc - 6, cm - 6);
    ctx.lineTo(cc + 6, cm + 6);
    ctx.moveTo(cc + 6, cm - 6);
    ctx.lineTo(cc - 6, cm + 6);
    ctx.stroke();

    // Scrollable content (clipped)
    ctx.save();
    ctx.beginPath();
    ctx.rect(HELP_X + 8, HELP_CY - 10, HELP_W - 16, HELP_CH + 16);
    ctx.clip();
    ctx.textAlign = "left";
    let y = HELP_CY - this.helpScroll;
    for (const [kind, text] of HELP_LINES) {
      if (kind === "h") {
        y += 12;
        ctx.font = `15px ${FONT}`;
        ctx.fillStyle = COLORS.gold;
        ctx.fillText(text, HELP_CX, y);
        y += HEAD_ADV - 12;
      } else if (kind === "s") {
        y += SPACER_ADV;
      } else {
        ctx.font = `14px ${FONT}`;
        ctx.fillStyle = "#e8f2fc";
        ctx.fillText(text, HELP_CX, y);
        y += BODY_ADV;
      }
    }
    ctx.restore();

    // Scrollbar
    if (HELP_MAX_SCROLL > 0) {
      const trackX = HELP_X + HELP_W - 12;
      const trackY = HELP_CY - 4;
      const trackH = HELP_CH + 4;
      ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
      ctx.fillRect(trackX, trackY, 4, trackH);
      const thumbH = Math.max(30, trackH * (HELP_CH / HELP_TOTAL));
      const thumbY = trackY + (trackH - thumbH) * (this.helpScroll / HELP_MAX_SCROLL);
      ctx.fillStyle = "rgba(140, 190, 235, 0.7)";
      ctx.fillRect(trackX, thumbY, 4, thumbH);
    }

    // "scroll for more" chevron
    if (this.helpScroll < HELP_MAX_SCROLL - 1) {
      const ay = HELP_Y + HELP_H - 14;
      ctx.strokeStyle = "#ffe27a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(VIEW_W / 2 - 8, ay - 4);
      ctx.lineTo(VIEW_W / 2, ay + 2);
      ctx.lineTo(VIEW_W / 2 + 8, ay - 4);
      ctx.stroke();
    }
  }

  scrollHelp(dy: number): void {
    this.helpScroll = clamp(this.helpScroll + dy, 0, HELP_MAX_SCROLL);
  }

  isOnClose(x: number, y: number): boolean {
    return x >= closeX - 6 && x <= closeX + HELP_CLOSE + 6 && y >= closeY - 6 && y <= closeY + HELP_CLOSE + 6;
  }

  isInsidePanel(x: number, y: number): boolean {
    return x >= HELP_X && x <= HELP_X + HELP_W && y >= HELP_Y && y <= HELP_Y + HELP_H;
  }
}

export class MenuStep extends GameStep {
  name = "menu";
  private starting = false;
  private art!: MenuArt;
  private soundHint: Entities.Label | null = null;
  private unsubAuth: (() => void) | null = null;
  private authResolved = false; // true once onAuthStateChanged has fired once
  private hydratedOnce = false; // boot-time preload snapshot consumed already
  private logoutBtn: Entities.Button | null = null;
  private googleBtn: Entities.Button | null = null;
  private musicOn = false;

  /* Help modal — buttons hidden while open, drag/wheel to scroll */
  private menuButtons: Entities.Button[] = [];
  private openingHelp = false;
  private helpDragging = false;
  private helpLastY = 0;
  private helpDragged = false;

  constructor(board: Board) {
    super(board);
    board.onMouseEvent("click", (_e: MouseEvent, x: number, y: number) => {
      if (board.step !== this) return;
      if (this.soundHint) this.soundHint.visible = false;
      // First gesture unlocks audio; give Howler a beat to resume, then start.
      if (!this.musicOn) setTimeout(() => this.startMenuMusic(), 80);
      if (this.art && !this.art.showHelp && Math.abs(x - MUTE_CX) <= MUTE_R + 4 && Math.abs(y - MUTE_CY) <= MUTE_R + 4) {
        const muted = toggleMute();
        if (!muted) this.board.playSound("click", false, 0.4);
        track("toggle_mute", { muted });
        return;
      }
      if (!this.art?.showHelp || this.openingHelp) return;
      // X or a tap on the dark backdrop closes; a drag never does
      if (this.art.isOnClose(x, y)) this.closeHelp();
      else if (!this.art.isInsidePanel(x, y) && !this.helpDragged) this.closeHelp();
      this.helpDragged = false;
    });
    board.onMouseEvent("mousedown", (_e: MouseEvent, x: number, y: number) => {
      if (board.step !== this || !this.art?.showHelp) return;
      if (this.art.isInsidePanel(x, y)) {
        this.helpDragging = true;
        this.helpLastY = y;
        this.helpDragged = false;
      }
    });
    board.onMouseEvent("mousemove", (_e: MouseEvent, _x: number, y: number) => {
      if (board.step !== this || !this.helpDragging || !this.art) return;
      const dy = y - this.helpLastY;
      this.helpLastY = y;
      if (Math.abs(dy) > 1) this.helpDragged = true;
      this.art.scrollHelp(-dy);
    });
    board.onMouseEvent("mouseup", () => {
      this.helpDragging = false;
    });
    window.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        if (board.step !== this || !this.art?.showHelp) return;
        e.preventDefault();
        this.art.scrollHelp(e.deltaY);
      },
      { passive: false }
    );
    board.onKeyboardEvent("keydown", (e: KeyboardEvent) => {
      if (board.step !== this) return;
      if (this.art?.showHelp) {
        if (e.code === "Escape") this.closeHelp();
        else if (e.code === "ArrowDown") this.art.scrollHelp(40);
        else if (e.code === "ArrowUp") this.art.scrollHelp(-40);
        return;
      }
      if (this.starting) return;
      if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space") this.startGame();
    });
  }

  private openHelp(): void {
    this.board.playSound("click", false, 0.4);
    track("help_opened");
    this.art.showHelp = true;
    this.art.helpScroll = 0;
    for (const b of this.menuButtons) b.visible = false;
    if (this.logoutBtn) this.logoutBtn.visible = false;
    this.openingHelp = true;
    setTimeout(() => (this.openingHelp = false), 0);
  }

  private closeHelp(): void {
    this.art.showHelp = false;
    this.helpDragging = false;
    this.helpDragged = false;
    this.board.playSound("click", false, 0.4);
    // The board click handler runs BEFORE the entity pass in the same tap
    // (engine dispatch order). Re-showing the buttons now would let this very
    // tap — a tap "beside" the modal lands on CONNEXION GOOGLE, just under the
    // panel — leak onto a freshly revealed button. Defer the reveal one tick.
    setTimeout(() => {
      if (this.board.step !== this || this.art.showHelp) return;
      for (const b of this.menuButtons) b.visible = true;
      this.refreshAccount(); // restores the LOGOUT button only when logged in
    }, 0);
  }

  onEnter(): void {
    this.starting = false;
    this.openingHelp = false;
    this.helpDragging = false;
    this.helpDragged = false;
    this.menuButtons = [];
    this.authResolved = false;
    this.camera.x = 0;
    this.camera.y = 0;
    trackScreen("menu");
    this.startMenuMusic();

    this.board.addEntity(new TileMap());
    this.art = new MenuArt();
    this.art.soloWins = loadBest()?.wins ?? 0;
    this.board.addEntity(this.art);
    // Instant paint from the splash preload (no loading flash); a live refresh
    // below keeps it honest. Only on the FIRST entry, though — the snapshot is
    // boot-time, so later visits (e.g. after logging in) rely on the live
    // refresh instead, which reveals the label only once resolved.
    const cached = this.hydratedOnce ? null : cachedMenuData();
    if (cached) {
      this.hydratedOnce = true;
      this.authResolved = true;
      this.art.authReady = true;
      this.art.authName = cached.name ?? "invite";
      this.art.leaderboard = cached.leaderboard;
      this.art.multiWins = cached.rank?.entry.wins ?? null;
      this.art.myRank = cached.rank?.rank ?? null;
      this.art.myUid = cached.rank?.entry.uid ?? "";
    }
    this.refreshAccount();
    this.refreshLeaderboard();
    this.unsubAuth = onUserChange(() => {
      this.authResolved = true; // auth state is now authoritative
      this.refreshAccount();
      this.refreshLeaderboard();
    });

    const playBtn = this.makeButton(VIEW_W / 2 - 140, 504, 280, 58, "JOUER", "#ffe27a", 22);
    playBtn.onMouseEvent("click", () => this.startGame());

    const multiBtn = this.makeButton(VIEW_W / 2 - 140, 574, 280, 50, "MULTIJOUEUR", "#7fd1ff", 17);
    multiBtn.onMouseEvent("click", () => this.goLobby());

    const helpBtn = this.makeButton(VIEW_W / 2 - 140, 636, 280, 44, "COMMENT JOUER", "rgba(190, 215, 240, 0.9)", 15);
    helpBtn.onMouseEvent("click", () => this.openHelp());

    // Bottom row: MES STATS (left) + auth (right), side by side, no overlap.
    const statsBtn = this.makeButton(40, 884, 250, 34, "MES STATS", "#ffe27a", 12);
    statsBtn.onMouseEvent("click", () => {
      track("stats_opened");
      this.board.playSound("click", false, 0.4);
      openStatsModal();
    });

    const googleBtn = this.makeButton(350, 884, 250, 34, "CONNEXION GOOGLE", "#7fd1ff", 10);
    googleBtn.onMouseEvent("click", () => {
      track("login", { method: "google" });
      this.authAction(() => this.signInGoogleWithPseudo());
    });
    this.googleBtn = googleBtn;
    this.menuButtons = [playBtn, multiBtn, helpBtn, statsBtn, googleBtn];

    // LOGOUT shares the right slot with CONNEXION GOOGLE — only one shows.
    this.logoutBtn = this.makeButton(350, 884, 250, 34, "LOGOUT", "rgba(190, 215, 240, 0.9)", 11);
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
    this.helpDragging = false;
    this.board.stopSound("menu_music", true, 400);
    this.musicOn = false;
    this.unsubAuth?.();
    this.unsubAuth = null;
  }

  /**
   * Start the menu loop. Browsers block audio before a gesture; Howler's
   * autoUnlock resumes the queued track on the first tap, and the musicOn
   * guard keeps a second visit (or the soundHint tap) from stacking voices.
   */
  private startMenuMusic(): void {
    if (this.musicOn || !audioReady()) return; // wait for the first tap to unlock audio
    this.musicOn = true;
    this.board.playSound("menu_music", true, 0.32);
  }

  private refreshAccount(): void {
    const user = currentUser();
    const loggedIn = !!user && !user.isAnonymous;
    this.art.myUid = loggedIn ? user!.uid : "";
    if (!loggedIn) {
      this.art.multiWins = null;
      this.art.myRank = null;
    }
    // Resolve the label to its FINAL value before revealing it (no Google-name
    // flash): connected → fetch the chosen pseudo, then show; guest → "invite",
    // but only once auth has actually resolved (avoids a false "invite" flash
    // while persistence is still restoring the session on first load).
    if (loggedIn) {
      const uid = user!.uid;
      profileName(user!).then((n) => {
        if (this.board.step !== this || currentUser()?.uid !== uid) return; // stale
        this.art.authName = n;
        this.art.authReady = true;
      });
    } else if (this.authResolved) {
      this.art.authName = "invite";
      this.art.authReady = true;
    }
    // Google and Logout share the bottom-right slot: exactly one is shown
    // (and both stay hidden while the help modal covers the row).
    if (this.logoutBtn) this.logoutBtn.visible = loggedIn && !this.art.showHelp;
    if (this.googleBtn) this.googleBtn.visible = !loggedIn && !this.art.showHelp;
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
    const { asked } = await signInGoogleWithPseudo();
    if (asked) track("set_pseudo");
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
