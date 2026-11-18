/**
 * Vérifie l'enregistrement des parties solo : un joueur simulé affronte l'IA à
 * chaque niveau, la partie est enregistrée, puis REJOUÉE depuis l'enregistrement —
 * le résultat (vainqueur, durée au tick près, part de carte) doit être identique.
 * Usage : node tools/replay-check.mjs [--file partie.json]   (rejoue un export)
 */
import http from "http";
import { readFile } from "fs/promises";
import { readFileSync, readdirSync } from "fs";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fi = process.argv.indexOf("--file");
const PORT = 8800 + Math.floor(Math.random() * 90);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".woff2": "font/woff2" };
const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || "/").split("?")[0];
    const file = join(ROOT, url === "/" ? "index.html" : decodeURIComponent(url));
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(PORT, r));
const base = `${process.env.HOME}/Library/Caches/ms-playwright`;
const dirs = readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort();
const browser = await chromium.launch({ executablePath: `${base}/${dirs[dirs.length - 1]}/chrome-headless-shell-mac-arm64/chrome-headless-shell`, args: ["--mute-audio"] });
const pageJs = await readFile(join(ROOT, "tools/balance-lab-page.js"), "utf8");
const open = async () => {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  return page;
};

let failed = 0;
const check = async (label, rec) => {
  const page = await open(); // page neuve : la relecture ne doit rien devoir à la partie d'origine
  await page.evaluate(pageJs);
  const r = await page.evaluate((x) => window.__lab.replay(x), rec);
  await page.close();
  const same = r.ended && r.ticks === rec.ticks && r.win === rec.win && Math.abs(r.share - rec.share) < 0.0015;
  if (!same) failed++;
  console.log(`${same ? "✓" : "✗"} ${label} : ${rec.cmds.length} ordres, ${rec.ticks} ticks, ${rec.win ? "victoire" : "défaite"} joueur, part ${rec.share} → relecture ${r.ticks} ticks, ${r.win ? "victoire" : "défaite"}, part ${r.share}`);
};

if (fi >= 0) {
  const raw = JSON.parse(readFileSync(process.argv[fi + 1], "utf8"));
  for (const [i, rec] of (Array.isArray(raw) ? raw : [raw]).entries()) await check(`partie ${i + 1} (${rec.difficulty}, v${rec.version})`, rec);
} else {
  for (const level of ["easy", "medium", "hard", "insane"]) {
    const page = await open();
    const rec = await page.evaluate((lv) => {
      const w = window.__bgewwar, ai = w.ai, play = w.steps.play;
      w.board.playSound = () => {}; w.board.stopSound = () => {};
      play.update = () => {}; play.draw = () => {};
      w.board.moveToStep("game", { difficulty: lv });
      const me = new ai.Commander(play.battleView(), 2, ai.sanitizeGenome(ai.BASE_GENOME), (c) => play.queueCmd(c));
      for (let tick = 0; tick < 60 * 600 && !play.ended; tick++) {
        if (tick % 90 === 0 && play.elapsed >= 4) me.think();
        play.simStep();
      }
      return play.lastRecord;
    }, level);
    await page.close();
    if (!rec) { failed++; console.log(`✗ ${level} : aucune partie enregistrée`); continue; }
    await check(level, rec);
  }
}
await browser.close();
server.close();
console.log(failed ? `${failed} relecture(s) différente(s)` : "Relectures identiques ✓");
process.exit(failed ? 1 : 0);
