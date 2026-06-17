import { Board, Entities, Entity, GameStep, Network } from "@fuwu-yuan/bgew";
import { COLORS, FONT, VIEW_H, VIEW_W } from "../globals";
import { gameData } from "../network";
import { TileMap } from "../entities/tilemap";
import { Fader } from "../entities/effects";
import { drawSprite, SPR } from "../sprites";
import { trackScreen } from "../analytics";

interface SalonData {
  seat: "creator" | "joiner";
  mode: "quick" | "private";
  code?: string;
  /** Host (blue) draw, decided at room creation. The joiner reads it from room data. */
  creatorHosts?: boolean;
}

const BLUE_UI = "#7fd1ff";
const RED_UI = "#ff8b7a";

/** Waiting-room art: title, (private) code, the two player slots, status. */
class SalonArt extends Entity {
  public mode: "quick" | "private" = "quick";
  public isCreator = true;
  public code = "";
  public opponentIn = false;
  public status = "";
  public statusColor = "#bfd9f2";
  public copied = false;
  // Real camp colours, known once the host draw is resolved.
  public colorsReady = false;
  public myColor = "#9fc3e4";
  public enemyColor = "#9fc3e4";
  public myCamp = "?";
  public enemyCamp = "?";
  public myBlue = true;
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
    ctx.fillStyle = "rgba(6, 16, 32, 0.72)";
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    ctx.textAlign = "center";
    ctx.font = `54px ${FONT}`;
    ctx.lineWidth = 8;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    const title = this.mode === "private" ? "PARTIE PRIVEE" : "PARTIE RAPIDE";
    ctx.strokeText(title, VIEW_W / 2, 122);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(title, VIEW_W / 2, 122);

    // Private creator: show the code prominently + sharing hint.
    if (this.mode === "private" && this.isCreator && this.code) {
      ctx.fillStyle = "rgba(10, 25, 45, 0.85)";
      ctx.fillRect(VIEW_W / 2 - 150, 168, 300, 78);
      ctx.strokeStyle = "rgba(255, 226, 122, 0.7)";
      ctx.lineWidth = 2;
      ctx.strokeRect(VIEW_W / 2 - 150, 168, 300, 78);
      ctx.font = `12px ${FONT}`;
      ctx.fillStyle = "#9fc3e4";
      ctx.fillText("CODE DE LA PARTIE", VIEW_W / 2, 192);
      ctx.font = `40px ${FONT}`;
      ctx.fillStyle = COLORS.gold;
      ctx.fillText(this.code.split("").join(" "), VIEW_W / 2, 232);
      ctx.font = `11px ${FONT}`;
      ctx.fillStyle = this.copied ? "#5dde6a" : "#bfd9f2";
      ctx.fillText(this.copied ? "Lien copie !" : "Partage le code ou le lien avec ton ami", VIEW_W / 2, 262);
    }

    // Player slots — coloured by the player's real camp once known.
    const dots = ".".repeat(1 + (Math.floor(this.t * 2) % 3));
    const slotY = this.mode === "private" && this.isCreator ? 296 : 236;
    const slot = (y: number, label: string, color: string, camp: string, filled: boolean, blue: boolean) => {
      ctx.fillStyle = "rgba(10, 25, 45, 0.85)";
      ctx.fillRect(110, y, VIEW_W - 220, 60);
      ctx.strokeStyle = filled ? color : "rgba(120, 140, 160, 0.4)";
      ctx.lineWidth = 2;
      ctx.strokeRect(110, y, VIEW_W - 220, 60);
      drawSprite(ctx, this.colorsReady ? (blue ? SPR.B_FLAG : SPR.R_FLAG) : SPR.HEDGEHOG, 144, y + 30, 30);
      ctx.textAlign = "left";
      ctx.font = `15px ${FONT}`;
      ctx.fillStyle = color;
      ctx.fillText(label, 172, y + 26);
      ctx.font = `12px ${FONT}`;
      ctx.fillStyle = filled ? "#e8f2fc" : "rgba(190, 215, 240, 0.55)";
      const sub = this.colorsReady ? `Camp ${camp}` : "Camp tire au sort…";
      ctx.fillText(filled ? sub : `En attente d'un joueur${dots}`, 172, y + 46);
      if (filled) {
        ctx.textAlign = "right";
        ctx.fillStyle = "#5dde6a";
        ctx.font = `18px ${FONT}`;
        ctx.fillText("✓", VIEW_W - 132, y + 38);
      }
      ctx.textAlign = "center";
    };
    slot(slotY, "VOUS", this.colorsReady ? this.myColor : "#9fc3e4", this.myCamp, true, this.myBlue);
    slot(slotY + 72, "ADVERSAIRE", this.colorsReady ? this.enemyColor : "#9fc3e4", this.enemyCamp, this.opponentIn, !this.myBlue);

    if (this.status) {
      ctx.font = `15px ${FONT}`;
      ctx.fillStyle = this.statusColor;
      ctx.fillText(this.status, VIEW_W / 2, slotY + 184);
    }
    ctx.textAlign = "left";
  }
}

/**
 * The waiting room. The host (blue) is drawn at random at room creation so
 * both sides can show their real colours here. The room CREATOR presses
 * COMMENCER to launch (quick or private) once the opponent has joined.
 */
export class SalonStep extends GameStep {
  name = "salon";

  private art!: SalonArt;
  private seat: "creator" | "joiner" = "creator";
  private mode: "quick" | "private" = "quick";
  private code = "";
  private creatorHosts: boolean | null = null;
  private launchBtn: Entities.Button | null = null;
  private copyBtn: Entities.Button | null = null;
  private leaving = false;
  private pollTimer: ReturnType<GameStep["addTimer"]> | null = null;

  constructor(board: Board) {
    super(board);
  }

  private get nm(): Network.NetworkManager {
    return this.board.networkManager as Network.NetworkManager;
  }

  onEnter(data: SalonData): void {
    this.seat = data.seat;
    this.mode = data.mode;
    this.code = data.code ?? "";
    this.creatorHosts = typeof data.creatorHosts === "boolean" ? data.creatorHosts : null;
    this.leaving = false;
    this.camera.x = 0;
    this.camera.y = 0;
    trackScreen("salon");

    this.board.addEntity(new TileMap());
    this.art = new SalonArt();
    this.art.mode = this.mode;
    this.art.isCreator = this.seat === "creator";
    this.art.code = this.code;
    this.art.opponentIn = this.seat === "joiner"; // a joiner already sees both seats filled
    this.board.addEntity(this.art);
    this.applyColors();

    // The launch button (creator only), revealed once the opponent is present.
    if (this.seat === "creator") {
      if (this.mode === "private") {
        this.art.status = "Ton ami doit ouvrir le jeu, MULTIJOUEUR, REJOINDRE avec le code";
        this.copyBtn = this.makeButton(VIEW_W / 2 - 150, 502, "COPIER LE LIEN", "#7fd1ff");
        this.copyBtn.onMouseEvent("click", () => this.copyLink());
        this.launchBtn = this.makeButton(VIEW_W / 2 - 150, 564, "COMMENCER LA PARTIE", "#ffe27a");
      } else {
        this.art.status = "Recherche d'un adversaire de ton niveau…";
        this.launchBtn = this.makeButton(VIEW_W / 2 - 150, 470, "COMMENCER LA PARTIE", "#ffe27a");
      }
      this.launchBtn.visible = false;
      this.launchBtn.onMouseEvent("click", () => this.launch());
      // Make sure the host draw is stored for the joiner to read.
      if (this.creatorHosts === null) this.creatorHosts = Math.random() < 0.5;
      this.applyColors();
      this.nm.setRoomData({ creatorHosts: this.creatorHosts }, true).catch(() => undefined);
      // The opponent may have joined while we were fading in.
      this.nm
        .getOpenedRooms()
        .then(({ servers }) => {
          const mine = (servers || []).find((r) => r.uid === this.nm.roomuid);
          if (mine && (mine.clients?.length ?? 0) >= 2) this.onPlayerJoin();
        })
        .catch(() => undefined);
    } else {
      this.art.status = "En attente du lancement par l'hote…";
      // Learn the host draw (for colours) right away, and keep polling as a
      // fallback for both the colours and the launch signal.
      this.refreshFromRoomData();
      this.pollTimer = this.addTimer(
        2000,
        () => {
          if (this.leaving || this.board.step !== this) return;
          this.refreshFromRoomData();
        },
        true
      );
    }

    const quit = this.makeButton(VIEW_W / 2 - 150, VIEW_H - 120, this.mode === "quick" ? "ANNULER" : "QUITTER LE SALON", "rgba(190, 215, 240, 0.6)");
    quit.onMouseEvent("click", () => this.quit());

    this.board.addEntity(new Fader(1, 0, 400));
  }

  onLeave(): void {
    this.launchBtn = null;
    this.copyBtn = null;
    if (this.pollTimer) {
      this.removeTimer(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Resolve the real camp colours from the host draw + seat. */
  private applyColors(): void {
    if (this.creatorHosts === null) {
      this.art.colorsReady = false;
      return;
    }
    const myBlue = this.seat === "creator" ? this.creatorHosts : !this.creatorHosts;
    this.art.myBlue = myBlue;
    this.art.myColor = myBlue ? BLUE_UI : RED_UI;
    this.art.enemyColor = myBlue ? RED_UI : BLUE_UI;
    this.art.myCamp = myBlue ? "BLEU" : "ROUGE";
    this.art.enemyCamp = myBlue ? "ROUGE" : "BLEU";
    this.art.colorsReady = true;
  }

  /** Joiner: read room data for the host draw (colours) and the launch flag. */
  private refreshFromRoomData(): void {
    this.nm
      .getRoomData()
      .then((res) => {
        if (this.leaving || this.board.step !== this) return;
        const d = res.status === "success" ? res.data : null;
        if (d && typeof d.creatorHosts === "boolean" && this.creatorHosts === null) {
          this.creatorHosts = d.creatorHosts;
          this.applyColors();
        }
        if (d && d.started) this.startAsJoiner(d.creatorHosts === true);
      })
      .catch(() => undefined);
  }

  /* ------------------------------------------------------------ *
   * Network events
   * ------------------------------------------------------------ */

  onPlayerJoin(): void {
    if (this.seat !== "creator" || this.leaving) return;
    this.art.opponentIn = true;
    this.board.playSound("coin", false, 0.5);
    this.art.status = "Adversaire connecte — clique sur COMMENCER !";
    this.art.statusColor = "#7fd1ff";
    if (this.launchBtn) this.launchBtn.visible = true;
  }

  onPlayerLeave(): void {
    if (this.leaving) return;
    if (this.seat === "creator") {
      this.art.opponentIn = false;
      this.art.status = this.mode === "quick" ? "Recherche d'un adversaire de ton niveau…" : "L'adversaire a quitte le salon…";
      this.art.statusColor = this.mode === "quick" ? "#bfd9f2" : "#ff8b7a";
      if (this.launchBtn) this.launchBtn.visible = false;
      this.board.playSound("error", false, 0.4);
    } else {
      this.board.playSound("error", false, 0.4);
      this.exitTo("lobby");
    }
  }

  onNetworkMessage(msg: Network.SocketMessage): void {
    if (this.seat !== "joiner") return;
    const d = gameData(msg);
    if (d?.type === "start") {
      this.startAsJoiner((d as { creatorHosts?: boolean }).creatorHosts === true);
    }
  }

  // Arrow property: the engine passes this UNBOUND to rxjs as the websocket
  // complete-callback (a plain method would lose `this`).
  onConnectionClosed = (): void => {
    if (this.board.step !== this || this.leaving) return;
    this.exitTo("lobby");
  };

  /* ------------------------------------------------------------ *
   * Launch
   * ------------------------------------------------------------ */

  private launch(): void {
    if (this.leaving || this.seat !== "creator" || !this.art.opponentIn) return;
    this.leaving = true;
    this.board.playSound("click", false, 0.5);
    const creatorHosts = this.creatorHosts ?? Math.random() < 0.5;
    this.nm.closeRoom(this.nm.roomuid, true).catch(() => undefined);
    // Flag in room data first (poll fallback), then broadcast.
    this.nm.setRoomData({ started: true, creatorHosts }, true).catch(() => undefined);
    this.board.networkManager.sendMessage({ type: "start", creatorHosts }).catch(() => undefined);
    this.gotoGame(creatorHosts ? "host" : "guest");
  }

  private startAsJoiner(creatorHosts: boolean): void {
    if (this.leaving) return;
    this.leaving = true;
    this.board.playSound("click", false, 0.5);
    this.gotoGame(creatorHosts ? "guest" : "host");
  }

  private gotoGame(role: "host" | "guest"): void {
    this.board.addEntity(
      new Fader(0, 1, 450, "#08111f", () => {
        this.board.moveToStep("game", { multi: { role } });
      })
    );
  }

  /* ------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------ */

  private copyLink(): void {
    this.board.playSound("click", false, 0.4);
    const link = `${window.location.origin}${window.location.pathname}?join=${this.code}`;
    const done = () => {
      this.art.copied = true;
      this.addTimer(2500, () => (this.art.copied = false), false);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(link).then(done).catch(() => window.prompt("Copie ce lien :", link));
    } else {
      window.prompt("Copie ce lien :", link);
    }
  }

  private quit(): void {
    if (this.leaving) return;
    this.board.playSound("click", false, 0.4);
    if (this.seat === "creator") {
      this.nm.closeRoom(this.nm.roomuid, true).catch(() => undefined);
    }
    this.board.networkManager.leaveRoom();
    this.exitTo("lobby");
  }

  private exitTo(step: string): void {
    if (this.leaving) return;
    this.leaving = true;
    this.board.addEntity(
      new Fader(0, 1, 400, "#08111f", () => {
        this.board.moveToStep(step, {});
      })
    );
  }

  private makeButton(x: number, y: number, text: string, color: string): Entities.Button {
    const btn = new Entities.Button(x, y, 300, 52, text);
    btn.fontFamily = FONT;
    btn.fontSize = 16;
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
