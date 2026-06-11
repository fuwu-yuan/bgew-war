import { Board } from "@fuwu-yuan/bgew";
import { COLORS, GAME_NAME, GAME_VERSION, VIEW_H, VIEW_W } from "./globals";
import { loadSprites } from "./sprites";
import { installNetwork } from "./network";
import { MenuStep } from "./steps/menu.step";
import { PlayStep } from "./steps/game.step";
import { LobbyStep } from "./steps/lobby.step";
import { EndStep } from "./steps/end.step";

const board = new Board(
  GAME_NAME,
  GAME_VERSION,
  VIEW_W,
  VIEW_H,
  document.getElementById("game"),
  COLORS.background,
  false,
  // Engine collision system (BVH) disabled: hundreds of marching units use
  // the game's own tile-bucket targeting instead.
  false
);
board.config.game.FPS = 60;

/* ------------------------------------------------------------------ *
 * Responsive scale — desktop & mobile.
 * board.scale drives the canvas buffer size, the engine applies it in
 * Entity.draw (ctx.scale) and reverses it in mouse coordinates, so the
 * whole game keeps thinking in 640×1024.
 * ------------------------------------------------------------------ */
function fitToScreen(): void {
  const s = Math.min(window.innerWidth / VIEW_W, window.innerHeight / VIEW_H);
  board.scale = Math.max(0.25, Math.min(s, 2));
}
fitToScreen();
window.addEventListener("resize", fitToScreen);
window.addEventListener("orientationchange", () => setTimeout(fitToScreen, 120));

/* ------------------------------------------------------------------ *
 * Touch bridge — the engine only listens to mouse events. Taps become
 * instant synthetic mouse events (preventDefault also kills the 300 ms
 * delayed click and page scrolling).
 * ------------------------------------------------------------------ */
const synth = (type: string, t: Touch) =>
  board.canvas.dispatchEvent(
    new MouseEvent(type, { clientX: t.clientX, clientY: t.clientY, button: 0, bubbles: false })
  );
board.canvas.addEventListener(
  "touchstart",
  (e: TouchEvent) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    synth("mousemove", t);
    synth("mousedown", t);
  },
  { passive: false }
);
board.canvas.addEventListener(
  "touchmove",
  (e: TouchEvent) => {
    e.preventDefault();
    synth("mousemove", e.changedTouches[0]);
  },
  { passive: false }
);
board.canvas.addEventListener(
  "touchend",
  (e: TouchEvent) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    synth("mouseup", t);
    synth("click", t);
  },
  { passive: false }
);

/* Sounds — CC0: Kenney (sci-fi, interface, jingles) + "Cynic Battle Loop"
 * by cynicmusic (opengameart.org). WAV/M4A so iOS Safari plays them too. */
const sfx = (name: string, ext = "wav", repeat = false, volume = 0.5) =>
  board.registerSound(name, `assets/sounds/${name}.${ext}`, repeat, volume);
sfx("shot1", "wav", false, 0.12);
sfx("shot2", "wav", false, 0.12);
sfx("shot3", "wav", false, 0.12);
sfx("tankshot", "wav", false, 0.2);
sfx("turret", "wav", false, 0.1);
sfx("explosion1", "wav", false, 0.25);
sfx("explosion2", "wav", false, 0.4);
sfx("explosion_big", "wav", false, 0.55);
sfx("capture", "wav", false, 0.16);
sfx("coin", "wav", false, 0.5);
sfx("build", "wav", false, 0.5);
sfx("click", "wav", false, 0.4);
sfx("error", "wav", false, 0.4);
sfx("victory", "m4a", false, 0.6);
sfx("defeat", "m4a", false, 0.6);
sfx("music_battle", "m4a", true, 0.3);

/* Network: same protocol as the official server, overridable via ?server= */
installNetwork(board);

/* Steps */
const menu = new MenuStep(board);
const play = new PlayStep(board);
const lobby = new LobbyStep(board);
const end = new EndStep(board);
board.addSteps([menu, play, lobby, end]);
board.step = menu;

/* Test hook for the headless smoke test (harmless in production) */
(window as unknown as Record<string, unknown>).__bgewwar = { board, steps: { menu, play, lobby, end } };

board.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

/* Wait for the spritesheet and the title font before the first frame */
const start = () => board.start();
const ready: Promise<unknown>[] = [loadSprites()];
if (document.fonts && document.fonts.load) {
  ready.push(document.fonts.load("400 92px 'Black Ops One'"));
}
Promise.all(ready).then(start).catch((err) => {
  console.error(err);
  start();
});
