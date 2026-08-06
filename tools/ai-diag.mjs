/** Diagnostic une-partie : compte où part l'or de l'IA rouge à une difficulté. */
import http from "http";
import { readFile } from "fs/promises";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8769;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json", ".wav": "audio/wav", ".m4a": "audio/mp4", ".woff2": "font/woff2", ".png": "image/png" };
const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || "/").split("?")[0];
    const file = join(ROOT, url === "/" ? "index.html" : decodeURIComponent(url));
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(PORT, r));

const executablePath = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const browser = await chromium.launch({ executablePath, args: ["--autoplay-policy=no-user-gesture-required"] });
const DIFF_BTN = { easy: 579, medium: 633, hard: 687, insane: 741 };
const diff = process.argv[2] || "hard";

const page = await browser.newPage({ viewport: { width: 700, height: 1100 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off&bot=1`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
const canvas = await page.locator("#game canvas").boundingBox();
const scale = canvas.width / 640;
const at = (x, y) => [canvas.x + x * scale, canvas.y + y * scale];
await page.mouse.click(...at(320, 533));
await page.waitForTimeout(400);
await page.mouse.click(...at(320, DIFF_BTN[diff]));
await page.waitForTimeout(900);

await page.evaluate(() => {
  const play = window.__bgewwar.steps.play;
  const stats = { redStrikes: 0, redHelis: 0, redBuilds: { barracks: 0, turret: 0, factory: 0 }, redUpgrades: 0 };
  window.__aistats = stats;
  const s0 = play.scheduleStrike.bind(play);
  play.scheduleStrike = (x, y, f) => { if (f === 1) stats.redStrikes++; return s0(x, y, f); };
  const h0 = play.spawnHeli.bind(play);
  play.spawnHeli = (f, x) => { if (f === 1) stats.redHelis++; return h0(f, x); };
  const p0 = play.placeBuilding.bind(play);
  play.placeBuilding = (f, t, c, r, i) => { if (f === 1 && stats && t !== "hq") stats.redBuilds[t] = (stats.redBuilds[t] || 0) + 1; return p0(f, t, c, r, i); };
  const u0 = play.buyUpgrade.bind(play);
  play.buyUpgrade = (f, k) => { if (f === 1) stats.redUpgrades++; return u0(f, k); };
});

for (let chunk = 0; chunk < 8; chunk++) {
  const s = await page.evaluate(() => {
    const play = window.__bgewwar.steps.play;
    for (let i = 0; i < 1800 && !play.ended; i++) play.simStep();
    const alive = play.buildings.filter((b) => !b.dead);
    return {
      t: Math.round(play.elapsed),
      ended: play.ended,
      botWin: play.endData?.win,
      share: Math.round(play.blueShare * 100),
      goldR: Math.round(play.gold[1]),
      goldB: Math.round(play.gold[2]),
      lvlR: [play.levels[1], play.tankLevels[1], play.turretLevels[1]].join("/"),
      lvlB: [play.levels[2], play.tankLevels[2], play.turretLevels[2]].join("/"),
      bR: alive.filter((b) => b.faction === 1).length,
      bB: alive.filter((b) => b.faction === 2).length,
      stats: window.__aistats,
    };
  });
  console.log(JSON.stringify(s));
  if (s.ended) break;
}
await browser.close();
server.close();
