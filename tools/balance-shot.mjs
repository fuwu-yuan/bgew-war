/**
 * Captures d'une partie du banc d'équilibrage à intervalles réguliers
 * (pour VOIR ce que font les armées, pas seulement compter).
 * Usage: node tools/balance-shot.mjs <red> <blue> <seed> <outDir> [variant.json] [everySec] [maxSec]
 */
import http from "http";
import { readFile, writeFile } from "fs/promises";
import { readdirSync, mkdirSync } from "fs";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [red, blue, seed, outDir, variant, every = "20", maxSec = "300"] = process.argv.slice(2);
const overrides = variant && variant !== "-" ? JSON.parse(await readFile(variant, "utf8")) : null;
const PORT = 8600 + Math.floor(Math.random() * 100);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".woff2": "font/woff2" };
const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || "/").split("?")[0];
    const file = join(ROOT, url === "/" ? "index.html" : decodeURIComponent(url));
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));
const base = `${process.env.HOME}/Library/Caches/ms-playwright`;
const dirs = readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort();
const browser = await chromium.launch({ executablePath: `${base}/${dirs[dirs.length - 1]}/chrome-headless-shell-mac-arm64/chrome-headless-shell`, args: ["--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 660, height: 1040 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.evaluate(await readFile(join(ROOT, "tools/balance-lab-page.js"), "utf8"));
mkdirSync(outDir, { recursive: true });
await page.evaluate((o) => window.__lab.begin(o), { red, blue, seed: Number(seed), overrides, maxSeconds: Number(maxSec) });
for (let t = Number(every); ; t += Number(every)) {
  const shot = await page.evaluate((n) => {
    const res = window.__lab.run(n);
    const play = window.__bgewwar.steps.play;
    // un dessin réel (le labo coupe draw) : on rappelle celui du prototype
    const proto = Object.getPrototypeOf(play);
    const b = window.__bgewwar.board;
    b.ctx.clearRect(0, 0, b.canvas.width, b.canvas.height);
    proto.draw.call(play);
    // capture synchrone : la boucle du moteur efface le canvas à chaque tick
    return { res, png: b.canvas.toDataURL("image/png") };
  }, Number(every) * 60);
  await writeFile(join(outDir, `t${String(t).padStart(3, "0")}.png`), Buffer.from(shot.png.split(",")[1], "base64"));
  const r = shot.res;
  if (r) { console.log(JSON.stringify({ winner: r.winner, t: r.t, share: r.share, hq: r.hq, levels: r.levels })); break; }
}
await browser.close();
server.close();
