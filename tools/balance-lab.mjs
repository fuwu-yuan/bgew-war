/**
 * Banc d'équilibrage : tournoi entre STYLES de jeu scriptés (les deux camps
 * joués par le même type de commandant, IA du jeu coupée), en accéléré.
 *
 * Mesure ce qu'un bon équilibrage doit garantir :
 *   - durée des parties (médiane, extrêmes, nuls au temps limite) ;
 *   - matrice de victoires style × style (aucun style ne doit tout écraser) ;
 *   - symétrie rouge/bleu ; changements de meneur ; remontées.
 *
 * Usage :
 *   node tools/balance-lab.mjs [--styles a,b,c] [--seeds 4] [--variant fichier.json]
 *                              [--workers 6] [--max 900] [--out fichier.json] [--mirror]
 *   --variant : JSON de surcharges de BAL (src/balance.ts), ex. {"hq":{"hp":600}}
 *   --mirror  : uniquement les matchs miroir (style contre lui-même)
 */
import http from "http";
import { readFile, writeFile } from "fs/promises";
import { readdirSync } from "fs";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const PORT = 8790 + Math.floor(Math.random() * 200);
const SEEDS = Number(arg("seeds", 4));
const WORKERS = Number(arg("workers", 6));
const MAX_S = Number(arg("max", 900));
const variantPath = arg("variant", "");
const overrides = variantPath ? JSON.parse(await readFile(variantPath, "utf8")) : null;
// --defs fichier.json : styles supplémentaires { nom: { w: {...}, forward: bool } }
const styleDefs = arg("defs", "") ? JSON.parse(await readFile(arg("defs", ""), "utf8")) : null;

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
    res.end("not found");
  }
});
await new Promise((r) => server.listen(PORT, r));

function findChromium() {
  const base = `${process.env.HOME}/Library/Caches/ms-playwright`;
  const dirs = readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort();
  return `${base}/${dirs[dirs.length - 1]}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
}
const browser = await chromium.launch({ executablePath: arg("chromium", findChromium()), args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const pageJs = await readFile(join(ROOT, "tools/balance-lab-page.js"), "utf8");

async function newWorker() {
  const page = await browser.newPage({ viewport: { width: 700, height: 1100 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.evaluate(pageJs);
  return { page, errors };
}

async function playMatch(w, m) {
  await w.page.evaluate((o) => window.__lab.begin(o), { ...m, overrides, styleDefs, maxSeconds: MAX_S });
  for (;;) {
    const r = await w.page.evaluate(() => window.__lab.run(2400));
    if (r) return r;
  }
}

const probe = await newWorker();
const allStyles = await probe.page.evaluate(() => window.__lab.styles);
const styles = arg("styles", "") ? arg("styles", "").split(",") : allStyles;

// Chaque paire joue SEEDS fois dans chaque couleur.
const jobs = [];
for (let a = 0; a < styles.length; a++) {
  for (let b = a; b < styles.length; b++) {
    if (flag("mirror") && a !== b) continue;
    for (let s = 0; s < SEEDS; s++) {
      jobs.push({ red: styles[a], blue: styles[b], seed: 1000 + s * 7919 + a * 31 + b * 131 });
      if (a !== b) jobs.push({ red: styles[b], blue: styles[a], seed: 5000 + s * 7919 + a * 31 + b * 131 });
    }
  }
}

const t0 = Date.now();
const results = [];
let next = 0;
const workers = [probe];
while (workers.length < Math.min(WORKERS, jobs.length)) workers.push(await newWorker());
await Promise.all(
  workers.map(async (w) => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const r = await playMatch(w, job);
      results.push({ ...job, ...r });
      if (w.errors.length) {
        console.log(`  !! erreur page: ${w.errors.splice(0).join(" | ")}`);
      }
    }
  })
);
await browser.close();
server.close();

/* ---------------- rapport ---------------- */
const med = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const pctile = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

const durations = results.map((r) => r.t);
const draws = results.filter((r) => r.winner === 0).length;
const decided = results.filter((r) => r.winner !== 0);
const redWins = decided.filter((r) => r.winner === 1).length;
console.log(`\n${results.length} parties en ${((Date.now() - t0) / 1000).toFixed(0)} s${variantPath ? ` — variante ${variantPath}` : " — réglages actuels"}`);
console.log(`Durée : médiane ${mmss(med(durations))}, 10 % ${mmss(pctile(durations, 0.1))}, 90 % ${mmss(pctile(durations, 0.9))} · nuls (limite ${mmss(MAX_S)}) : ${draws}`);
console.log(`Rouge gagne ${redWins}/${decided.length} des parties décidées · changements de meneur/partie : ${(results.reduce((s, r) => s + r.leadChanges, 0) / results.length).toFixed(2)} · remontées : ${decided.filter((r) => r.comeback).length}/${decided.length} · pic d'unités médian : ${med(results.map((r) => r.peakUnits))}`);

// Matrice : score du style en ligne contre le style en colonne (victoire 1, nul 0,5).
const score = {};
const dur = {};
for (const a of styles) {
  score[a] = {};
  dur[a] = {};
  for (const b of styles) {
    score[a][b] = [0, 0];
    dur[a][b] = [];
  }
}
for (const r of results) {
  const rs = r.winner === 1 ? 1 : r.winner === 0 ? 0.5 : 0;
  score[r.red][r.blue][0] += rs;
  score[r.red][r.blue][1] += 1;
  dur[r.red][r.blue].push(r.t);
  if (r.red !== r.blue) {
    score[r.blue][r.red][0] += 1 - rs;
    score[r.blue][r.red][1] += 1;
    dur[r.blue][r.red].push(r.t);
  }
}
const pad = (s, n) => String(s).padEnd(n);
if (!flag("mirror")) {
  console.log(`\nScore (ligne contre colonne, % de victoires) :`);
  console.log(pad("", 10) + styles.map((s) => pad(s.slice(0, 8), 9)).join("") + "TOTAL");
  for (const a of styles) {
    let tot = 0;
    let n = 0;
    const cells = styles.map((b) => {
      const [w, g] = score[a][b];
      if (a === b || !g) return pad("  ·", 9);
      tot += w;
      n += g;
      return pad(`${Math.round((w / g) * 100)}%`, 9);
    });
    console.log(pad(a, 10) + cells.join("") + (n ? `${Math.round((tot / n) * 100)}%` : ""));
  }
}
console.log(`\nDurée médiane (ligne contre colonne) :`);
console.log(pad("", 10) + styles.map((s) => pad(s.slice(0, 8), 9)).join(""));
for (const a of styles) {
  console.log(pad(a, 10) + styles.map((b) => pad(dur[a][b].length ? mmss(med(dur[a][b])) : "  ·", 9)).join(""));
}

const out = arg("out", "");
if (out) {
  await writeFile(out, JSON.stringify({ variant: overrides, results }, null, 1));
  console.log(`\nDétail écrit dans ${out}`);
}
process.exit(0);
