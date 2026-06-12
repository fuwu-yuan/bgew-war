/**
 * Génère favicon + icônes PWA (iOS/Android) dans assets/icons/.
 * Dessin vectoriel sur-mesure aux couleurs du jeu (rouge en haut, bleu en
 * bas, ligne de front en zig-zag, char en silhouette) rendu en headless
 * Chromium puis exporté en PNG à chaque taille.
 *
 * Usage : npm run icons
 */
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "icons");
mkdirSync(OUT, { recursive: true });

const executablePath =
  process.argv[2] ||
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

// [nom, taille, maskable?] — maskable = char réduit dans la zone de sécurité Android
const TARGETS = [
  ["favicon-16.png", 16, false],
  ["favicon-32.png", 32, false],
  ["apple-touch-icon-180.png", 180, false],
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-512.png", 512, true],
];

const draw = `(S, maskable) => {
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const ctx = cv.getContext("2d");

  // Fond bleu plein puis triangle rouge à bord en dents de scie (le front)
  ctx.fillStyle = "#2f86d4";
  ctx.fillRect(0, 0, S, S);
  const segs = 6, midY = S * 0.5, amp = S * 0.07;
  const frontY = (i) => midY + (i % 2 === 0 ? -amp : amp);
  ctx.fillStyle = "#e8533f";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(S, 0);
  for (let i = segs; i >= 0; i--) ctx.lineTo((S / segs) * i, frontY(i));
  ctx.closePath();
  ctx.fill();

  // Ligne de front blanche
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(2, S * 0.03);
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i <= segs; i++) {
    const x = (S / segs) * i, y = frontY(i);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Char en silhouette navy, centré sur la ligne (réduit si maskable)
  const k = maskable ? 0.78 : 1;
  const cx = S * 0.5, cy = S * 0.5;
  const tw = S * 0.56 * k, th = S * 0.42 * k;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = "#0a1428";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(1.5, S * 0.018);
  ctx.lineJoin = "round";
  const r = th * 0.18;
  const round = (x, y, w, h, rad) => {
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  };
  // chenilles
  round(-tw / 2, th * 0.12, tw, th * 0.34, r);
  // canon (pointe à droite)
  round(tw * 0.18, -th * 0.18, tw * 0.46, th * 0.13, r * 0.5);
  // tourelle
  round(-tw * 0.30, -th * 0.40, tw * 0.42, th * 0.32, r);
  // caisse
  round(-tw / 2, -th * 0.12, tw * 0.92, th * 0.28, r);
  ctx.restore();

  return cv.toDataURL("image/png");
}`;

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
await page.setContent("<!doctype html><body></body>");
for (const [name, size, maskable] of TARGETS) {
  const dataUrl = await page.evaluate(`(${draw})(${size}, ${maskable})`);
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  writeFileSync(join(OUT, name), Buffer.from(b64, "base64"));
  console.log(`✓ ${name} (${size}×${size}${maskable ? ", maskable" : ""})`);
}
await browser.close();
