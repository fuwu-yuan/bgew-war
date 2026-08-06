/**
 * Repro: end-of-match freeze in SOLO. Builds a LARGE battle (many units firing
 * → bullets + effects), then forces the BLUE (player) HQ down. The battle is
 * MEANT to keep raging behind the end-screen fade (explosions look nice), but
 * at the fixed 60Hz tick with sweepDead — so entities must stay BOUNDED, not
 * pile up (the freeze was real-delta combat with no sweep, doubling the board).
 * We measure both the frame rate and the entity-count trajectory through the
 * transition window.
 *
 * Usage: node tools/end-freeze-test.mjs [runs]
 */
import http from "http";
import { readFile } from "fs/promises";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8767;
const RUNS = Number(process.argv[2] || 4);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json", ".wav": "audio/wav", ".m4a": "audio/mp4", ".woff2": "font/woff2", ".png": "image/png" };

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || "/").split("?")[0];
    const file = join(ROOT, url === "/" ? "index.html" : decodeURIComponent(url));
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(PORT, r));

const executablePath = process.argv[3] || `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const browser = await chromium.launch({ executablePath, args: ["--autoplay-policy=no-user-gesture-required"] });

const results = [];
for (let run = 1; run <= RUNS; run++) {
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 760, height: 1100 } });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`CONSOLE: ${m.text()}`); });

  await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const canvas = await page.locator("#game canvas").boundingBox();
  const scale = canvas.width / 640;
  const at = (x, y) => [canvas.x + x * scale, canvas.y + y * scale];
  await page.mouse.click(...at(320, 533)); // JOUER
  await page.waitForTimeout(500);
  await page.mouse.click(...at(320, 633)); // difficulte MOYEN
  await page.waitForTimeout(2500);

  // Build a heavy battle: a big mass of units on BOTH sides so the screen is
  // full of bullets and explosions when the HQ falls.
  const pre = await page.evaluate(() => {
    const play = window.__bgewwar.steps.play;
    const W = 640, midY = 440;
    for (let i = 0; i < 220; i++) {
      play.spawnSoldier(1, 40 + Math.random() * (W - 80), midY - 60 - Math.random() * 80);
      play.spawnSoldier(2, 40 + Math.random() * (W - 80), midY + 60 + Math.random() * 80);
    }
    return { units: play.units.length };
  });
  // Let them fight 1.5s → bullets and effects everywhere.
  await page.waitForTimeout(1500);
  const mid = await page.evaluate(() => {
    const play = window.__bgewwar.steps.play;
    return { units: play.units.length, bullets: play.bullets.length, effects: play.effects.length };
  });

  // Kill the BLUE HQ → player loses.
  const killed = await page.evaluate(() => {
    const play = window.__bgewwar.steps.play;
    const hq = play.buildings.find((b) => b.type === "hq" && b.faction === 2 && !b.dead);
    if (!hq || play.ended) return { ok: false };
    play.notifyKill(hq, 1);
    return { ok: true };
  });

  // Sample fps + entity counts repeatedly through the end-transition window.
  const samples = [];
  const t0 = Date.now();
  let stepName = "play";
  while (Date.now() - t0 < 5000) {
    const s = await page.evaluate(() => new Promise((resolve) => {
      let f = 0; const t = performance.now();
      const tick = () => { f++; if (performance.now() - t < 500) requestAnimationFrame(tick); else {
        const play = window.__bgewwar.steps.play;
        resolve({ fps: Math.round(f / ((performance.now() - t) / 1000)), units: play.units?.length ?? -1, bullets: play.bullets?.length ?? -1, effects: play.effects?.length ?? -1, step: window.__bgewwar.board.step.name });
      } };
      requestAnimationFrame(tick);
    }));
    samples.push(s);
    stepName = s.step;
    if (stepName === "end") break;
  }
  const minFps = Math.min(...samples.map((s) => s.fps));
  const ent0 = mid.units + mid.bullets + mid.effects;
  const maxEnt = Math.max(...samples.map((s) => s.units + s.bullets + s.effects));
  const reached = stepName === "end";
  // Regression: once the match ends the sim is frozen, so the entity count must
  // NOT keep climbing (the old bug kept units firing → unbounded pile-up).
  const grew = maxEnt > ent0 * 1.25;
  const ok = killed.ok && reached && minFps > 20 && errors.length === 0 && !grew;
  results.push({ run, ok, minFps, maxEnt, reached, grew });
  console.log(`run ${run}: battle units=${mid.units} bullets=${mid.bullets} fx=${mid.effects} (ent0=${ent0}) | end: minFps=${minFps} maxEntities=${maxEnt} grew=${grew} reached=${reached}` + (errors.length ? ` ERR=${errors.length} ${errors[0]}` : ""));
  console.log(`   samples: ${samples.map((s)=>`${s.step}:${s.fps}fps/${s.units+s.bullets+s.effects}e`).join("  ")}`);
  await page.close();
}

const fails = results.filter((r) => !r.ok);
console.log(`\n${RUNS - fails.length}/${RUNS} runs OK`);
await browser.close();
server.close();
process.exit(fails.length ? 1 : 0);
