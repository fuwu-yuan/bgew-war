import { Board } from "@fuwu-yuan/bgew";
import { COLORS, GAME_NAME, GAME_VERSION, VIEW_H, VIEW_W } from "./globals";
import { loadSprites } from "./sprites";
import { installNetwork } from "./network";
import { MenuStep } from "./steps/menu.step";
import { PlayStep } from "./steps/game.step";
import { LobbyStep } from "./steps/lobby.step";
import { SalonStep } from "./steps/salon.step";
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
 * Responsive scale + HiDPI (Retina) — desktop & mobile.
 * board.scale reste le scale LOGIQUE : le moteur s'en sert pour la
 * conversion souris et le ctx.scale de chaque entité, le jeu continue
 * de penser en 640×1024.
 * La netteté Retina ne peut PAS venir du enableHIDPI du moteur : la
 * gameloop refait `canvas.width = W * scale` à chaque tick et écrase
 * son dimensionnement. À la place, on surdimensionne le buffer
 * (scale × devicePixelRatio) au début de chaque frame dans clear() —
 * appelé en tête de chaque step.draw(), juste après le resize du tick —
 * avec une pré-transformation ctx.scale(dpr) que les save/restore par
 * entité préservent. Le CSS ramène l'affichage à la taille logique,
 * et la souris reste juste (rect CSS = W×scale, divisé par scale).
 * ------------------------------------------------------------------ */
let dpr = 1;
function fitToScreen(): void {
  const s = Math.min(window.innerWidth / VIEW_W, window.innerHeight / VIEW_H);
  board.scale = Math.max(0.25, Math.min(s, 2));
  dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
  board.canvas.style.width = `${VIEW_W * board.scale}px`;
  board.canvas.style.height = `${VIEW_H * board.scale}px`;
}
fitToScreen();
window.addEventListener("resize", fitToScreen);
window.addEventListener("orientationchange", () => setTimeout(fitToScreen, 120));

const engineClear = board.clear.bind(board);
board.clear = () => {
  if (dpr !== 1) {
    board.canvas.width = Math.round(VIEW_W * board.scale * dpr);
    board.canvas.height = Math.round(VIEW_H * board.scale * dpr);
    board.ctx.scale(dpr, dpr);
  }
  engineClear();
};

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
sfx("helico", "wav", true, 0.22);
sfx("victory", "m4a", false, 0.6);
sfx("defeat", "m4a", false, 0.6);
sfx("music_battle", "m4a", true, 0.3);

/* Network: same protocol as the official server, overridable via ?server= */
installNetwork(board);

/* Steps */
const menu = new MenuStep(board);
const play = new PlayStep(board);
const lobby = new LobbyStep(board);
const salon = new SalonStep(board);
const end = new EndStep(board);
board.addSteps([menu, play, lobby, salon, end]);
board.step = menu;

/* Test hook for the headless smoke test (harmless in production) */
(window as unknown as Record<string, unknown>).__bgewwar = { board, steps: { menu, play, lobby, salon, end } };

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
