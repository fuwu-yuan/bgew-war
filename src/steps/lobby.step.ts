import { Board, Entities, Entity, GameStep, Network } from "@fuwu-yuan/bgew";
import { COLORS, FONT, VIEW_H, VIEW_W } from "../globals";
import { gameData, serverLabel } from "../network";
import { randInt } from "../utils";
import { TileMap } from "../entities/tilemap";
import { Fader } from "../entities/effects";
import { drawSprite, SPR } from "../sprites";
import { track, trackScreen } from "../analytics";

type LobbyState = "idle" | "creating" | "waiting" | "joining" | "starting";

/** Dark veil + title + status text above the live island background. */
class LobbyArt extends Entity {
  public status = "";
  public statusColor = "#bfd9f2";

  constructor() {
    super(0, 0, VIEW_W, VIEW_H);
    this.disabled = true;
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
    ctx.fillText("1 contre 1 — l'hote joue les BLEUS, l'invite les ROUGES", VIEW_W / 2, 172);
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = "rgba(159, 195, 228, 0.7)";
    ctx.fillText(`Serveur : ${serverLabel()}`, VIEW_W / 2, 196);

    if (this.status) {
      ctx.font = `16px ${FONT}`;
      ctx.fillStyle = this.statusColor;
      ctx.fillText(this.status, VIEW_W / 2, 240);
    }
    ctx.textAlign = "left";
  }
}

export class LobbyStep extends GameStep {
  name = "lobby";

  private art!: LobbyArt;
  private state: LobbyState = "idle";
  private roomButtons: Entities.Button[] = [];
  private actionButtons: Entities.Button[] = [];

  constructor(board: Board) {
    super(board);
  }

  onEnter(): void {
    this.state = "idle";
    this.roomButtons = [];
    this.actionButtons = [];
    this.camera.x = 0;
    this.camera.y = 0;
    trackScreen("lobby");

    this.board.addEntity(new TileMap());
    this.art = new LobbyArt();
    this.board.addEntity(this.art);

    const create = this.makeButton(VIEW_W / 2 - 150, 280, "CREER UNE PARTIE", "#ffe27a");
    create.onMouseEvent("click", () => this.createRoom());
    const refresh = this.makeButton(VIEW_W / 2 - 150, 352, "ACTUALISER LA LISTE", "rgba(190, 215, 240, 0.9)");
    refresh.onMouseEvent("click", () => {
      this.board.playSound("click", false, 0.4);
      this.refreshRooms();
    });
    const back = this.makeButton(VIEW_W / 2 - 150, VIEW_H - 110, "RETOUR", "rgba(190, 215, 240, 0.6)");
    back.onMouseEvent("click", () => this.goBack());
    this.actionButtons = [create, refresh, back];

    this.board.addEntity(new Fader(1, 0, 400));
    this.refreshRooms();
  }

  onLeave(): void {
    this.roomButtons = [];
    this.actionButtons = [];
  }

  /* ------------------------------------------------------------ *
   * Network events (engine routes them to the active step)
   * ------------------------------------------------------------ */

  onNetworkMessage(msg: Network.SocketMessage): void {
    // Race shield: the host can launch while we are still fading toward the
    // salon — catch the "start" here and go straight to war
    if (gameData(msg)?.type === "start" && this.state === "joining") {
      this.state = "starting";
      this.board.addEntity(
        new Fader(0, 1, 450, "#08111f", () => {
          this.board.moveToStep("game", { multi: { role: "guest" } });
        })
      );
    }
  }

  // Arrow property: the engine passes this handler UNBOUND to rxjs as the
  // websocket complete-callback — a plain method would run with `this`
  // pointing at the rxjs observer and crash.
  onConnectionClosed = (): void => {
    if (this.state === "starting" || this.board.step !== this) return;
    this.state = "idle";
    this.setStatus("Connexion au salon perdue", true);
  };

  /* ------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------ */

  private createRoom(): void {
    if (this.state !== "idle") return;
    this.state = "creating";
    this.board.playSound("click", false, 0.4);
    this.setStatus("Creation du salon…");
    const roomName = `Guerre #${randInt(100, 999)}`;
    this.board.networkManager
      .createRoom(roomName, 2, {}, true)
      .then((res) => {
        if (res.status === "success") {
          this.state = "starting";
          track("room_created");
          this.board.addEntity(
            new Fader(0, 1, 350, "#08111f", () => {
              this.board.moveToStep("salon", { role: "host", roomName });
            })
          );
        } else {
          this.state = "idle";
          this.setStatus(`Erreur : ${res.code}`, true);
        }
      })
      .catch(() => {
        this.state = "idle";
        this.setStatus("Serveur injoignable — ajoutez ?server=<hote> a l'URL", true);
      });
  }

  private refreshRooms(): void {
    for (const b of this.roomButtons) this.board.removeEntity(b);
    this.roomButtons = [];
    this.board.networkManager
      .getOpenedRooms()
      .then(({ servers }) => {
        const rooms = (servers || []).slice(0, 4);
        if (this.state === "idle") {
          this.setStatus(rooms.length === 0 ? "Aucune partie ouverte — creez la votre !" : "Touchez une partie pour la rejoindre :");
        }
        rooms.forEach((room, k) => {
          const btn = this.makeButton(
            VIEW_W / 2 - 150,
            440 + k * 64,
            `${room.name}  (${room.clients ? room.clients.length : "?"}/2)`,
            "#7fd1ff",
            48
          );
          btn.onMouseEvent("click", () => this.joinRoom(room));
          this.roomButtons.push(btn);
        });
      })
      .catch(() => {
        if (this.state === "idle") {
          this.setStatus("Serveur injoignable — ajoutez ?server=<hote> a l'URL", true);
        }
      });
  }

  private joinRoom(room: Network.Room): void {
    if (this.state !== "idle") return;
    this.state = "joining";
    this.board.playSound("click", false, 0.4);
    this.setStatus(`Connexion a ${room.name}…`);
    this.board.networkManager
      .joinRoom(room.uid)
      .then((res) => {
        if (res.status === "success") {
          // Still "joining": the start-race shield above stays armed
          track("room_joined");
          this.board.addEntity(
            new Fader(0, 1, 350, "#08111f", () => {
              if (this.state !== "joining") return; // already gone to war
              this.board.moveToStep("salon", { role: "guest", roomName: room.name });
            })
          );
        } else {
          this.state = "idle";
          this.setStatus(res.code === "room_full" ? "Cette partie est deja pleine" : `Erreur : ${res.code}`, true);
        }
      })
      .catch(() => {
        this.state = "idle";
        this.setStatus("Impossible de rejoindre cette partie", true);
      });
  }

  private goBack(): void {
    this.board.playSound("click", false, 0.4);
    this.board.networkManager.leaveRoom();
    this.state = "starting"; // block further actions during the fade
    this.board.addEntity(
      new Fader(0, 1, 400, "#08111f", () => {
        this.board.moveToStep("menu", {});
      })
    );
  }

  private setStatus(text: string, error = false): void {
    this.art.status = text;
    this.art.statusColor = error ? "#ff8b7a" : "#bfd9f2";
  }

  private makeButton(x: number, y: number, text: string, color: string, h = 56): Entities.Button {
    const btn = new Entities.Button(x, y, 300, h, text);
    btn.fontFamily = FONT;
    btn.fontSize = 15;
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
