import { Board, Entities, Entity, GameStep, Network } from "@fuwu-yuan/bgew";
import { FONT, VIEW_H, VIEW_W } from "../globals";
import { genJoinCode, isMatchmakingRoom, mmRoomName, mmWins, pvCode, pvRoomName } from "../network";
import { cachedMenuData } from "../firebase";
import { TileMap } from "../entities/tilemap";
import { Fader } from "../entities/effects";
import { drawSprite, SPR } from "../sprites";
import { track, trackScreen } from "../analytics";

type LobbyView = "home" | "private";

/** Optional payload: deep-link join (from a shared `?join=CODE` link). */
interface LobbyData {
  joinCode?: string;
}

/** Dark veil + title + status text above the live island background. */
class LobbyArt extends Entity {
  public status = "";
  public statusColor = "#bfd9f2";
  public busy = false;
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

    drawSprite(ctx, SPR.B_FLAG, VIEW_W / 2 - 120, 120, 40);
    drawSprite(ctx, SPR.R_FLAG, VIEW_W / 2 + 120, 120, 40);
    ctx.textAlign = "center";
    ctx.font = `54px ${FONT}`;
    ctx.lineWidth = 8;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.strokeText("MULTIJOUEUR", VIEW_W / 2, 138);
    ctx.fillStyle = "#ffffff";
    ctx.fillText("MULTIJOUEUR", VIEW_W / 2, 138);
    ctx.font = `14px ${FONT}`;
    ctx.fillStyle = "#9fc3e4";
    ctx.fillText("1 contre 1 — le camp (bleu/rouge) est tire au sort", VIEW_W / 2, 172);

    if (this.status) {
      ctx.font = `16px ${FONT}`;
      ctx.fillStyle = this.statusColor;
      ctx.fillText(this.status, VIEW_W / 2, 244);
      // Searching spinner dots
      if (this.busy) {
        const dots = ".".repeat(1 + (Math.floor(this.t * 2) % 3));
        ctx.fillText(dots, VIEW_W / 2, 270);
      }
    }
    ctx.textAlign = "left";
  }
}

/**
 * Multiplayer entry point. Two ways to play:
 *   - PARTIE RAPIDE: auto match — join the open quick-match room closest in
 *     level (win count), or create one and wait. The host is drawn at random.
 *   - PARTIE PRIVEE: create a room with a short code + shareable link, or join
 *     a friend's room by code. Both reuse the relay rooms — no backend, and it
 *     works whether you're signed in or not (level = 0 when anonymous).
 */
export class LobbyStep extends GameStep {
  name = "lobby";

  private art!: LobbyArt;
  private view: LobbyView = "home";
  private busy = false; // a network action is in flight
  private leaving = false;
  private buttons: Entities.Button[] = [];

  constructor(board: Board) {
    super(board);
  }

  private get nm(): Network.NetworkManager {
    return this.board.networkManager as Network.NetworkManager;
  }

  onEnter(data?: LobbyData): void {
    this.view = "home";
    this.busy = false;
    this.leaving = false;
    this.camera.x = 0;
    this.camera.y = 0;
    trackScreen("lobby");

    this.board.addEntity(new TileMap());
    this.art = new LobbyArt();
    this.board.addEntity(this.art);
    this.board.addEntity(new Fader(1, 0, 400));

    if (data?.joinCode) {
      // Arrived via a shared link → jump straight to joining that code.
      this.joinPrivate(data.joinCode);
    } else {
      this.showHome();
    }
  }

  onLeave(): void {
    this.buttons = [];
  }

  // The relay drops us back here if a room we created/joined dies.
  onConnectionClosed = (): void => {
    if (this.leaving || this.board.step !== this) return;
    this.busy = false;
    this.showHome();
    this.setStatus("Connexion au salon perdue", true);
  };

  /* ------------------------------------------------------------ *
   * Views
   * ------------------------------------------------------------ */

  private clearButtons(): void {
    for (const b of this.buttons) this.board.removeEntity(b);
    this.buttons = [];
  }

  private showHome(): void {
    this.view = "home";
    this.clearButtons();
    this.setStatus("Choisis ton mode de jeu");
    const quick = this.makeButton(VIEW_W / 2 - 150, 320, "PARTIE RAPIDE", "#ffe27a");
    quick.onMouseEvent("click", () => this.quickMatch());
    const priv = this.makeButton(VIEW_W / 2 - 150, 392, "PARTIE PRIVEE", "#7fd1ff");
    priv.onMouseEvent("click", () => this.showPrivate());
    const back = this.makeButton(VIEW_W / 2 - 150, VIEW_H - 110, "RETOUR", "rgba(190, 215, 240, 0.6)");
    back.onMouseEvent("click", () => this.goMenu());
  }

  private showPrivate(): void {
    this.view = "private";
    this.clearButtons();
    this.board.playSound("click", false, 0.4);
    this.setStatus("Joue avec un ami via un code");
    const create = this.makeButton(VIEW_W / 2 - 150, 320, "CREER UNE PARTIE", "#ffe27a");
    create.onMouseEvent("click", () => this.createPrivate());
    const join = this.makeButton(VIEW_W / 2 - 150, 392, "REJOINDRE AVEC UN CODE", "#7fd1ff");
    join.onMouseEvent("click", () => this.promptJoinCode());
    const back = this.makeButton(VIEW_W / 2 - 150, VIEW_H - 110, "RETOUR", "rgba(190, 215, 240, 0.6)");
    back.onMouseEvent("click", () => this.showHome());
  }

  /* ------------------------------------------------------------ *
   * Quick match (auto)
   * ------------------------------------------------------------ */

  private quickMatch(): void {
    if (this.busy) return;
    this.busy = true;
    this.art.busy = true;
    track("mm_search");
    this.clearButtons();
    this.setStatus("Recherche d'un adversaire");
    const cancel = this.makeButton(VIEW_W / 2 - 150, 360, "ANNULER", "rgba(190, 215, 240, 0.6)");
    cancel.onMouseEvent("click", () => {
      this.busy = false;
      this.art.busy = false;
      this.board.playSound("click", false, 0.4);
      this.showHome();
    });

    const wins = cachedMenuData()?.rank?.entry.wins ?? 0;
    this.scanQuick(wins, false);
  }

  /**
   * Look for an open quick-match room to join. If none and this is the first
   * pass, wait a short RANDOM delay and scan ONCE more before creating our own
   * room — that staggering keeps two players who searched at the same instant
   * from each creating a room and waiting forever (one of them sees the other's
   * room on the second pass and joins it).
   */
  private scanQuick(wins: number, isRetry: boolean): void {
    if (!this.busy || this.board.step !== this) return;
    this.nm
      .getOpenedRooms()
      .then(({ servers }) => {
        if (!this.busy || this.board.step !== this) return; // cancelled
        const open = (servers || []).filter((r) => isMatchmakingRoom(r.name) && (r.clients?.length ?? 0) === 1);
        open.sort((a, b) => Math.abs(mmWins(a.name) - wins) - Math.abs(mmWins(b.name) - wins));
        this.tryJoinQuick(open, 0, wins, isRetry);
      })
      .catch(() => this.createQuick(wins));
  }

  private tryJoinQuick(list: Network.Room[], i: number, wins: number, isRetry: boolean): void {
    if (!this.busy || this.board.step !== this) return;
    if (i >= list.length) {
      if (!isRetry) {
        setTimeout(() => this.scanQuick(wins, true), 150 + Math.random() * 850);
      } else {
        this.createQuick(wins);
      }
      return;
    }
    this.nm
      .joinRoom(list[i].uid)
      .then((res) => {
        if (!this.busy || this.board.step !== this) return;
        if (res.status === "success") {
          track("mm_joined");
          this.gotoSalon({ seat: "joiner", mode: "quick" });
        } else {
          this.tryJoinQuick(list, i + 1, wins, isRetry); // full / gone — try next
        }
      })
      .catch(() => this.tryJoinQuick(list, i + 1, wins, isRetry));
  }

  private createQuick(wins: number): void {
    if (!this.busy || this.board.step !== this) return;
    // Draw the host (blue) NOW, at creation, and stash it in room data so both
    // players can show their real colours in the salon (before launch).
    const creatorHosts = Math.random() < 0.5;
    this.nm
      .createRoom(mmRoomName(wins), 2, { creatorHosts }, true)
      .then((res) => {
        if (!this.busy || this.board.step !== this) return;
        if (res.status === "success") {
          track("mm_created");
          this.gotoSalon({ seat: "creator", mode: "quick", creatorHosts });
        } else {
          this.busy = false;
          this.art.busy = false;
          this.showHome();
          this.setStatus(`Erreur : ${res.code}`, true);
        }
      })
      .catch(() => {
        this.busy = false;
        this.art.busy = false;
        this.showHome();
        this.setStatus("Serveur injoignable, reessaye plus tard", true);
      });
  }

  /* ------------------------------------------------------------ *
   * Private rooms (code + link)
   * ------------------------------------------------------------ */

  private createPrivate(): void {
    if (this.busy) return;
    this.busy = true;
    this.board.playSound("click", false, 0.4);
    this.clearButtons();
    this.setStatus("Creation de la partie privee");
    const code = genJoinCode();
    const creatorHosts = Math.random() < 0.5;
    this.nm
      .createRoom(pvRoomName(code), 2, { creatorHosts }, true)
      .then((res) => {
        if (this.board.step !== this) return;
        if (res.status === "success") {
          track("private_created");
          this.gotoSalon({ seat: "creator", mode: "private", code, creatorHosts });
        } else {
          this.busy = false;
          this.showPrivate();
          this.setStatus(`Erreur : ${res.code}`, true);
        }
      })
      .catch(() => {
        this.busy = false;
        this.showPrivate();
        this.setStatus("Serveur injoignable", true);
      });
  }

  private promptJoinCode(): void {
    this.board.playSound("click", false, 0.4);
    const raw = window.prompt("Entre le code de la partie (4 lettres) :", "");
    if (raw === null) return;
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) {
      this.setStatus("Code invalide (4 caracteres)", true);
      return;
    }
    this.joinPrivate(code);
  }

  private joinPrivate(code: string): void {
    if (this.busy) return;
    this.busy = true;
    this.view = "private";
    this.clearButtons();
    this.setStatus(`Connexion a la partie ${code}`);
    this.nm
      .getOpenedRooms()
      .then(({ servers }) => {
        if (this.board.step !== this) return;
        const room = (servers || []).find((r) => pvCode(r.name) === code);
        if (!room) {
          this.busy = false;
          this.showPrivate();
          this.setStatus("Aucune partie avec ce code", true);
          return;
        }
        return this.nm.joinRoom(room.uid).then((res) => {
          if (this.board.step !== this) return;
          if (res.status === "success") {
            track("private_joined");
            this.gotoSalon({ seat: "joiner", mode: "private", code });
          } else {
            this.busy = false;
            this.showPrivate();
            this.setStatus(res.code === "room_full" ? "Cette partie est deja pleine" : "Impossible de rejoindre", true);
          }
        });
      })
      .catch(() => {
        this.busy = false;
        this.showPrivate();
        this.setStatus("Serveur injoignable", true);
      });
  }

  /* ------------------------------------------------------------ *
   * Transitions
   * ------------------------------------------------------------ */

  private gotoSalon(data: { seat: "creator" | "joiner"; mode: "quick" | "private"; code?: string; creatorHosts?: boolean }): void {
    if (this.leaving) return;
    this.leaving = true;
    this.board.addEntity(
      new Fader(0, 1, 350, "#08111f", () => {
        this.board.moveToStep("salon", data);
      })
    );
  }

  private goMenu(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.board.playSound("click", false, 0.4);
    this.board.networkManager.leaveRoom();
    this.board.addEntity(
      new Fader(0, 1, 400, "#08111f", () => {
        this.board.moveToStep("menu", {});
      })
    );
  }

  private setStatus(text: string, error = false): void {
    this.art.status = text;
    this.art.statusColor = error ? "#ff8b7a" : "#bfd9f2";
    if (error) this.art.busy = false;
  }

  private makeButton(x: number, y: number, text: string, color: string, h = 56): Entities.Button {
    const btn = new Entities.Button(x, y, 300, h, text);
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
    this.buttons.push(btn);
    return btn;
  }
}
