import { Board, Entities, Entity, GameStep, Network } from "@fuwu-yuan/bgew";
import { FONT, VIEW_H, VIEW_W } from "../globals";
import { gameData, serverLabel } from "../network";
import { TileMap } from "../entities/tilemap";
import { Fader } from "../entities/effects";
import { drawSprite, SPR } from "../sprites";
import { trackScreen } from "../analytics";

interface SalonData {
  role: "host" | "guest";
  roomName: string;
}

/** Waiting-room art: title, room name, the two player slots, status. */
class SalonArt extends Entity {
  public roomName = "";
  public isHost = true;
  public opponentIn = false;
  public status = "";
  public statusColor = "#bfd9f2";
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
    ctx.strokeText("SALON", VIEW_W / 2, 130);
    ctx.fillStyle = "#ffffff";
    ctx.fillText("SALON", VIEW_W / 2, 130);

    ctx.font = `22px ${FONT}`;
    ctx.fillStyle = "#ffe27a";
    ctx.fillText(this.roomName, VIEW_W / 2, 174);
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = "rgba(159, 195, 228, 0.7)";
    ctx.fillText(`Serveur : ${serverLabel()}`, VIEW_W / 2, 198);

    // Player slots
    const dots = ".".repeat(1 + (Math.floor(this.t * 2) % 3));
    const slot = (
      y: number,
      flag: number,
      title: string,
      color: string,
      filled: boolean,
      who: string
    ) => {
      ctx.fillStyle = "rgba(10, 25, 45, 0.85)";
      ctx.fillRect(110, y, VIEW_W - 220, 64);
      ctx.strokeStyle = filled ? color : "rgba(120, 140, 160, 0.4)";
      ctx.lineWidth = 2;
      ctx.strokeRect(110, y, VIEW_W - 220, 64);
      drawSprite(ctx, flag, 146, y + 32, 34);
      ctx.textAlign = "left";
      ctx.font = `16px ${FONT}`;
      ctx.fillStyle = color;
      ctx.fillText(title, 175, y + 28);
      ctx.font = `13px ${FONT}`;
      ctx.fillStyle = filled ? "#e8f2fc" : "rgba(190, 215, 240, 0.55)";
      ctx.fillText(filled ? who : `En attente d'un joueur${dots}`, 175, y + 50);
      if (filled) {
        ctx.textAlign = "right";
        ctx.fillStyle = "#5dde6a";
        ctx.font = `18px ${FONT}`;
        ctx.fillText("✓", VIEW_W - 132, y + 40);
      }
      ctx.textAlign = "center";
    };
    slot(252, SPR.B_FLAG, "LES BLEUS", "#7fd1ff", true, this.isHost ? "Vous (hote)" : "L'hote");
    slot(336, SPR.R_FLAG, "LES ROUGES", "#ff8b7a", this.isHost ? this.opponentIn : true, this.isHost ? "Adversaire connecte" : "Vous");

    if (this.status) {
      ctx.font = `15px ${FONT}`;
      ctx.fillStyle = this.statusColor;
      ctx.fillText(this.status, VIEW_W / 2, 452);
    }
    ctx.textAlign = "left";
  }
}

/**
 * The waiting room. The host creates it from the lobby and launches the war
 * when the red player has joined; the guest waits for the launch here.
 */
export class SalonStep extends GameStep {
  name = "salon";

  private art!: SalonArt;
  private role: "host" | "guest" = "host";
  private launchBtn: Entities.Button | null = null;
  private leaving = false;
  private pollTimer: ReturnType<GameStep["addTimer"]> | null = null;

  constructor(board: Board) {
    super(board);
  }

  onEnter(data: SalonData): void {
    this.role = data.role;
    this.leaving = false;
    this.camera.x = 0;
    this.camera.y = 0;
    trackScreen("salon");

    this.board.addEntity(new TileMap());
    this.art = new SalonArt();
    this.art.roomName = data.roomName;
    this.art.isHost = this.role === "host";
    this.art.opponentIn = false;
    this.board.addEntity(this.art);

    if (this.role === "host") {
      this.art.status = "Votre ami doit ouvrir le jeu, MULTIJOUEUR, et rejoindre ce salon";
      this.launchBtn = this.makeButton(VIEW_W / 2 - 150, 492, "LANCER LA PARTIE", "#ffe27a");
      this.launchBtn.visible = false;
      this.launchBtn.onMouseEvent("click", () => this.launch());
      // The guest may have joined while we were fading in from the lobby
      const nm = this.board.networkManager as Network.NetworkManager;
      nm.getOpenedRooms()
        .then(({ servers }) => {
          const mine = (servers || []).find((r) => r.uid === nm.roomuid);
          if (mine && mine.clients.length >= 2) this.onPlayerJoin();
        })
        .catch(() => undefined);
    } else {
      this.art.opponentIn = true; // guest sees both slots filled
      this.art.status = "En attente du lancement par l'hote…";
      this.launchBtn = null;
      // Safety net: if the "start" broadcast gets lost (proxy hiccup…),
      // the room data flag set by the host still gets us into the war.
      const nm = this.board.networkManager as Network.NetworkManager;
      this.pollTimer = this.addTimer(
        2500,
        () => {
          if (this.leaving || this.board.step !== this) return;
          nm.getRoomData()
            .then((res) => {
              if (res.status === "success" && res.data?.started) this.startAsGuest();
            })
            .catch(() => undefined);
        },
        true
      );
    }

    const quit = this.makeButton(VIEW_W / 2 - 150, VIEW_H - 130, "QUITTER LE SALON", "rgba(190, 215, 240, 0.6)");
    quit.onMouseEvent("click", () => this.quit());

    this.board.addEntity(new Fader(1, 0, 400));
  }

  onLeave(): void {
    this.launchBtn = null;
    if (this.pollTimer) {
      this.removeTimer(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /* ------------------------------------------------------------ *
   * Network events
   * ------------------------------------------------------------ */

  onPlayerJoin(): void {
    if (this.role !== "host") return;
    this.art.opponentIn = true;
    this.art.status = "Adversaire trouve — a vous de lancer la guerre !";
    this.art.statusColor = "#7fd1ff";
    if (this.launchBtn) this.launchBtn.visible = true;
    this.board.playSound("coin", false, 0.5);
  }

  onPlayerLeave(): void {
    if (this.leaving) return;
    if (this.role === "host") {
      // The guest walked out: back to waiting
      this.art.opponentIn = false;
      this.art.status = "L'adversaire a quitte le salon…";
      this.art.statusColor = "#ff8b7a";
      if (this.launchBtn) this.launchBtn.visible = false;
      this.board.playSound("error", false, 0.4);
    } else {
      // The host is gone: this room is dead
      this.board.playSound("error", false, 0.4);
      this.exitTo("lobby");
    }
  }

  onNetworkMessage(msg: Network.SocketMessage): void {
    if (this.role === "guest" && gameData(msg)?.type === "start") {
      this.startAsGuest();
    }
  }

  private startAsGuest(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.board.playSound("click", false, 0.5);
    this.board.addEntity(
      new Fader(0, 1, 450, "#08111f", () => {
        this.board.moveToStep("game", { multi: { role: "guest" } });
      })
    );
  }

  // Arrow property: the engine passes this handler UNBOUND to rxjs as the
  // websocket complete-callback (see lobby.step.ts).
  onConnectionClosed = (): void => {
    if (this.board.step !== this || this.leaving) return;
    this.exitTo("lobby");
  };

  /* ------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------ */

  private launch(): void {
    if (this.leaving || !this.art.opponentIn) return;
    this.leaving = true;
    this.board.playSound("click", false, 0.5);
    const nm = this.board.networkManager as Network.NetworkManager;
    nm.closeRoom(nm.roomuid, true).catch(() => undefined);
    // Flag in room data first: the guest polls it as a fallback in case
    // the broadcast below never reaches them
    nm.setRoomData({ started: true }, true).catch(() => undefined);
    this.board.networkManager.sendMessage({ type: "start" }).catch(() => undefined);
    this.board.addEntity(
      new Fader(0, 1, 450, "#08111f", () => {
        this.board.moveToStep("game", { multi: { role: "host" } });
      })
    );
  }

  private quit(): void {
    if (this.leaving) return;
    this.board.playSound("click", false, 0.4);
    if (this.role === "host") {
      const nm = this.board.networkManager as Network.NetworkManager;
      nm.closeRoom(nm.roomuid, true).catch(() => undefined);
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
    const btn = new Entities.Button(x, y, 300, 56, text);
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
