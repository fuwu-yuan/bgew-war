/**
 * Dosage des niveaux : chaque niveau de l'IA solo (rouge) affronte quatre profils
 * de joueur simulés (bleu), du débutant à l'expert. La sim est avancée à la main.
 * Usage : node tools/level-bench.mjs [--matches 8] [--workers 10]
 */
import http from "http";
import { readFile } from "fs/promises";
import { readFileSync, readdirSync } from "fs";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
const MATCHES = opt("matches", 8), WORKERS = opt("workers", 10);
const trained = JSON.parse(readFileSync(join(ROOT, "src/trained.ts"), "utf8").match(/TRAINED_GENOME: Genome = (\{[\s\S]*\});/)[1]);

// Profils de joueur : doctrine + temps entre deux décisions + délai avant la première.
const PLAYERS = {
  debutant: { every: 6, grace: 12, tweak: "novice" },
  moyen: { every: 3, grace: 6 },
  bon: { every: 1, grace: 3 },
  expert: { every: 0.5, grace: 0, genome: trained },
};
const li = args.indexOf("--levels");
const LEVELS = li >= 0 ? args[li + 1].split(",") : ["easy", "medium", "hard", "insane"];

const PORT = 8700 + Math.floor(Math.random() * 90);
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

const jobs = [];
for (const level of LEVELS) for (const p of Object.keys(PLAYERS)) for (let i = 0; i < MATCHES; i++) jobs.push({ level, p, seed: 4000 + i * 7919 });
const out = [];
let next = 0;
await Promise.all(Array.from({ length: WORKERS }, async () => {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  while (next < jobs.length) {
    const j = jobs[next++];
    const r = await page.evaluate(({ level, prof, seed }) => {
      const w = window.__bgewwar, ai = w.ai, play = w.steps.play;
      let s = seed >>> 0;
      Math.random = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      w.board.playSound = () => {}; w.board.stopSound = () => {};
      play.update = () => {};
      play.draw = () => {};
      w.board.moveToStep("game", { difficulty: level });
      const g = ai.sanitizeGenome(prof.genome || ai.BASE_GENOME);
      if (prof.tweak === "novice") { g.w.strike = 0; g.w.heli = 0; g.w.soldierAtk *= 0.5; g.w.soldierDef *= 0.5; g.backMin = 0; }
      const me = new ai.Commander(play.battleView(), 2, g, (c) => play.queueCmd(c), Math.random);
      const every = Math.round(prof.every * 60);
      let tick = 0;
      for (; tick < 60 * 540 && !play.ended; tick++) {
        if (tick % every === 0 && play.elapsed >= prof.grace) me.think();
        play.simStep();
      }
      return { t: Math.round(play.elapsed), win: play.ended ? !!(play.endData && play.endData.win) : null, share: play.map.share(2) };
    }, { level: j.level, prof: PLAYERS[j.p], seed: j.seed });
    out.push({ ...j, ...r });
  }
  await page.close();
}));
await browser.close();
server.close();

const mmss = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
console.log(`Victoires du JOUEUR simulé sur ${MATCHES} parties (durée médiane)\n`);
console.log("niveau    " + Object.keys(PLAYERS).map((p) => p.padEnd(16)).join(""));
for (const level of LEVELS) {
  let line = level.padEnd(10);
  for (const p of Object.keys(PLAYERS)) {
    const m = out.filter((o) => o.level === level && o.p === p);
    const wins = m.filter((o) => o.win === true).length, draws = m.filter((o) => o.win === null).length;
    const t = m.map((o) => o.t).sort((a, b) => a - b)[m.length >> 1];
    line += `${wins}/${m.length}${draws ? ` (${draws} nuls)` : ""} ${mmss(t)}`.padEnd(16);
  }
  console.log(line);
}
