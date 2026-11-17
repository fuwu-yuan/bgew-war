/**
 * Entraînement de l'IA locale par AUTO-JEU (aucun appel à l'API Claude : tout
 * tourne sur cette machine).
 *
 * Une population de génomes (src/commander.ts) s'affronte en parties
 * accélérées ; les meilleurs survivent, se croisent et mutent, génération
 * après génération. Les adversaires sont : des styles fixes écrits à la main
 * (dont le style de Steve), le « panthéon » des anciens champions et les
 * autres membres de la population. Le champion est écrit dans
 * `src/trained.ts` (c'est lui que l'IA du jeu utilise).
 *
 * Usage :
 *   node tools/train.mjs                      sans affichage (le plus rapide, pour la nuit)
 *   node tools/train.mjs --show               mur de batailles sur tous les écrans
 *   node tools/train.mjs --show --screens 2,3 seulement certains écrans (1 = principal)
 *
 * Options : --generations N (défaut 30, 0 = jusqu'à Ctrl+C) · --pop 16 · --matches 8
 *           --workers 10 (sans affichage) · --cols 5 --rows 2 --speed 6 (avec --show)
 *           --max 540 (durée max d'une partie, s) · --fresh (repart de zéro)
 * L'état est sauvé dans training/state.json à chaque génération : relancer
 * la commande reprend là où on s'était arrêté. Ctrl+C sauve et exporte.
 */
import http from "http";
import { execFileSync } from "child_process";
import { readFile, writeFile, mkdir, mkdtemp } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);

const SHOW = flag("show");
const GENERATIONS = Number(arg("generations", 30));
const POP = Number(arg("pop", 16));
const MATCHES = Number(arg("matches", 8));
const WORKERS = Number(arg("workers", 10));
const COLS = Number(arg("cols", 5));
const ROWS = Number(arg("rows", 2));
const SPEED = Number(arg("speed", 6));
const MAX_S = Number(arg("max", 540));
const STATE_DIR = join(ROOT, "training");
const STATE_FILE = join(STATE_DIR, "state.json");
/** Styles fixes servant d'adversaires d'entraînement (voir balance-lab-page.js). */
const SPARRING = ["infantry", "expander", "armor", "bomber", "mixed", "fortress", "air", "no_tank"];

/* ---------------- serveur statique ---------------- */
const PORT = 8300 + Math.floor(Math.random() * 150);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json", ".wav": "audio/wav", ".m4a": "audio/mp4", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/json" };
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

/* ---------------- navigateurs et « ouvriers » ---------------- */
const CACHE = `${process.env.HOME}/Library/Caches/ms-playwright`;
const latest = (prefix) => {
  const dirs = readdirSync(CACHE).filter((d) => d.startsWith(prefix)).sort((a, b) => Number(a.split("-").pop()) - Number(b.split("-").pop()));
  if (!dirs.length) throw new Error(`Chromium introuvable (${prefix}*) dans ${CACHE} — lancer : npx playwright install chromium`);
  return `${CACHE}/${dirs[dirs.length - 1]}`;
};
const pageJs = await readFile(join(ROOT, "tools/balance-lab-page.js"), "utf8");
const closers = [];
/** Un ouvrier = un endroit où tourne une partie : { evaluate(fn, arg), caption?, result? } */
const workers = [];
let walls = [];

async function ready(target) {
  await target.waitForFunction(() => window.__bgewwar && window.__bgewwar.steps && window.__bgewwar.ai, null, { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 600)); // sprites/polices
  await target.evaluate(pageJs);
}

if (!SHOW) {
  const browser = await chromium.launch({
    executablePath: `${latest("chromium_headless_shell-")}/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    args: ["--mute-audio"],
  });
  closers.push(() => browser.close());
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      const page = await browser.newPage({ viewport: { width: 700, height: 1100 } });
      page.on("pageerror", (e) => console.log("  !! erreur page :", e.message));
      await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off`, { waitUntil: "load" });
      await ready(page);
      workers.push({ evaluate: (fn, a) => page.evaluate(fn, a) });
    })
  );
} else {
  // Géométrie des écrans (macOS) : origine en bas à gauche de l'écran principal → coin haut-gauche global.
  const raw = execFileSync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    'ObjC.import("AppKit"); JSON.stringify($.NSScreen.screens.js.map(s=>{const v=s.visibleFrame; return {x:v.origin.x,y:v.origin.y,w:v.size.width,h:v.size.height, fh:s.frame.size.height, fy:s.frame.origin.y}}))',
  ]).toString();
  const all = JSON.parse(raw);
  const mainH = all[0].fh;
  const pick = arg("screens", "") ? arg("screens", "").split(",").map((n) => Number(n) - 1) : all.map((_, i) => i);
  const screens = pick.filter((i) => all[i]).map((i) => ({ ...all[i], top: mainH - (all[i].y + all[i].h) }));
  console.log(`Écrans utilisés : ${screens.map((s) => `${s.w}×${s.h}`).join(", ")} — ${screens.length * COLS * ROWS} batailles en parallèle`);
  const exe = `${latest("chromium-")}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
  let first = 0;
  for (const s of screens) {
    const dir = await mkdtemp(join(tmpdir(), "bgew-train-"));
    const url = `http://localhost:${PORT}/tools/train-wall.html?cols=${COLS}&rows=${ROWS}&first=${first}`;
    const ctx = await chromium.launchPersistentContext(dir, {
      headless: false,
      executablePath: existsSync(exe) ? exe : undefined,
      viewport: null,
      args: [
        `--app=${url}`,
        `--window-position=${Math.round(s.x)},${Math.round(s.top)}`,
        `--window-size=${Math.round(s.w)},${Math.round(s.h)}`,
        "--mute-audio",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    closers.push(() => ctx.close());
    const page = ctx.pages()[0] || (await ctx.waitForEvent("page"));
    await page.waitForFunction(() => window.wall, null, { timeout: 30000 });
    walls.push(page);
    const base = first;
    for (let k = 0; k < COLS * ROWS; k++) {
      const host = `w${base + k}.localhost`;
      let frame = null;
      for (let tries = 0; tries < 100 && !frame; tries++) {
        frame = page.frames().find((f) => f.url().includes(`//${host}:`)) || null;
        if (!frame) await new Promise((r) => setTimeout(r, 200));
      }
      if (!frame) throw new Error(`cadre ${host} introuvable`);
      await ready(frame);
      workers.push({
        evaluate: (fn, a) => frame.evaluate(fn, a),
        caption: (red, blue, mid) => page.evaluate(([i, r, b, m]) => window.wall.caption(i, r, b, m), [k, red, blue, mid]).catch(() => {}),
        result: (winner, text) => page.evaluate(([i, w, t]) => window.wall.result(i, w, t), [k, winner, text]).catch(() => {}),
      });
    }
    first += COLS * ROWS;
  }
}
const setHead = (left, right) => Promise.all(walls.map((p) => p.evaluate(([l, r]) => window.wall.head(l, r), [left, right]).catch(() => {})));

/* ---------------- génomes ---------------- */
const meta = await workers[0].evaluate(() => {
  const ai = window.__bgewwar.ai;
  return { base: ai.BASE_GENOME, bounds: ai.GENE_BOUNDS, wb: ai.WEIGHT_BOUNDS, spend: ai.SPEND, styles: Object.fromEntries(window.__lab.styles.map((s) => [s, window.__lab.styleGenome(s)])) };
});
const rnd = Math.random;
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clone = (g) => JSON.parse(JSON.stringify(g));
let serial = 0;
const newId = () => `${(Date.now() % 46656).toString(36)}${(serial++ % 1296).toString(36).padStart(2, "0")}`;

function mutate(g, rate = 0.3) {
  const out = clone(g);
  for (const k of meta.spend) {
    if (rnd() > rate) continue;
    const v = out.w[k];
    // poids : bruit multiplicatif ; un poids nul peut renaître, un petit peut s'éteindre
    out.w[k] = v < 0.05 ? (rnd() < 0.5 ? 0.3 + rnd() * 0.5 : 0) : rnd() < 0.06 ? 0 : clamp(v * Math.exp(gauss() * 0.4), meta.wb[0], meta.wb[1]);
  }
  for (const k of Object.keys(meta.bounds)) {
    if (rnd() > rate) continue;
    const [lo, hi] = meta.bounds[k];
    out[k] = clamp(out[k] + gauss() * (hi - lo) * 0.14, lo, hi);
  }
  return out;
}
function cross(a, b) {
  const out = clone(a);
  for (const k of meta.spend) if (rnd() < 0.5) out.w[k] = b.w[k];
  for (const k of Object.keys(meta.bounds)) if (rnd() < 0.5) out[k] = b[k];
  return out;
}
const indiv = (genome, origin) => ({ id: newId(), genome, origin, points: 0, games: 0 });
const rate = (i) => (i.games > 0 ? i.points / i.games : 0);

/* ---------------- état (reprise) ---------------- */
let state;
if (!flag("fresh") && existsSync(STATE_FILE)) {
  state = JSON.parse(await readFile(STATE_FILE, "utf8"));
  console.log(`Reprise : génération ${state.generation}, ${state.totalGames} parties déjà jouées, panthéon ${state.hall.length}`);
} else {
  const pop = [indiv(clone(meta.base), "base")];
  for (const s of ["mixed", "infantry", "bomber", "armor"]) pop.push(indiv(clone(meta.styles[s]), s));
  while (pop.length < POP) pop.push(indiv(mutate(clone(meta.base), 0.6), "mutant"));
  state = { generation: 0, totalGames: 0, population: pop, hall: [], history: [] };
}
await mkdir(STATE_DIR, { recursive: true });

/* ---------------- une partie ---------------- */
async function playMatch(w, job) {
  const opts = { red: job.red.genome, blue: job.blue.genome, seed: job.seed, maxSeconds: MAX_S, visual: SHOW, speed: SPEED };
  if (w.caption) await w.caption(job.red.name, job.blue.name, `gén. ${state.generation + 1}`);
  await w.evaluate((o) => window.__lab.begin(o), opts);
  for (;;) {
    const r = SHOW ? await w.evaluate(() => window.__lab.poll()) : await w.evaluate(() => window.__lab.run(2400));
    if (r) {
      if (w.result) {
        await w.result(r.winner, r.winner === 0 ? "NUL" : `${r.winner === 1 ? job.red.name : job.blue.name} gagne`);
        await new Promise((res) => setTimeout(res, 1200));
      }
      return r;
    }
    if (SHOW) await new Promise((res) => setTimeout(res, 250));
  }
}

async function runJobs(jobs) {
  let next = 0;
  const out = new Array(jobs.length);
  await Promise.all(
    workers.map(async (w) => {
      while (next < jobs.length && !stopping) {
        const i = next++;
        try {
          out[i] = await playMatch(w, jobs[i]);
        } catch (e) {
          if (!stopping) console.log("  !! partie perdue :", String(e.message || e).split("\n")[0]);
          out[i] = null;
        }
      }
    })
  );
  return out;
}

/* ---------------- boucle d'évolution ---------------- */
let stopping = false;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const pct = (x) => `${Math.min(100, Math.round(x * 100))} %`; // le bonus de territoire peut dépasser 1

function champion() {
  const seasoned = state.population.filter((i) => i.games >= MATCHES);
  const pool = seasoned.length ? seasoned : state.population;
  return [...pool].sort((a, b) => rate(b) - rate(a))[0];
}

async function generation() {
  const pop = state.population;
  // l'expérience passée s'estompe : les adversaires changent d'une génération à l'autre
  for (const i of pop) {
    i.points *= 0.6;
    i.games *= 0.6;
  }
  const jobs = [];
  pop.forEach((ind, pi) => {
    for (let m = 0; m < MATCHES; m++) {
      const roll = rnd();
      let opp;
      if (roll < 0.5 || (state.hall.length === 0 && roll < 0.75)) {
        const s = SPARRING[(pi + m + state.generation) % SPARRING.length];
        opp = { name: s, genome: meta.styles[s] };
      } else if (roll < 0.75) {
        const h = state.hall[Math.floor(rnd() * state.hall.length)];
        opp = { name: `champion g${h.generation}`, genome: h.genome };
      } else {
        const o = pop[Math.floor(rnd() * pop.length)];
        opp = { name: `#${o.id}`, genome: o.genome };
      }
      const me = { name: `#${ind.id}`, genome: ind.genome };
      const asRed = m % 2 === 0;
      jobs.push({ pi, asRed, red: asRed ? me : opp, blue: asRed ? opp : me, seed: Math.floor(rnd() * 2 ** 31) });
    }
  });
  // mélange : les ouvriers voient des affiches variées
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
  }
  const t0 = Date.now();
  const results = await runJobs(jobs);
  const durations = [];
  results.forEach((r, k) => {
    if (!r) return;
    const j = jobs[k];
    const ind = pop[j.pi];
    const mine = j.asRed ? 1 : 2;
    const share = j.asRed ? 1 - r.share : r.share;
    // victoire 1, nul 0,5 ; le territoire final départage (± 0,05)
    ind.points += (r.winner === mine ? 1 : r.winner === 0 ? 0.5 : 0) + (share - 0.5) * 0.1;
    ind.games += 1;
    durations.push(r.t);
    state.totalGames++;
  });
  if (stopping) return;

  pop.sort((a, b) => rate(b) - rate(a));
  const best = pop[0];
  const mean = pop.reduce((s, i) => s + rate(i), 0) / pop.length;
  state.generation++;
  state.history.push({ generation: state.generation, best: +rate(best).toFixed(3), mean: +mean.toFixed(3), medianT: med(durations) });
  console.log(
    `Gén. ${state.generation} · meilleur ${pct(rate(best))} (#${best.id}, ${best.origin}) · moyenne ${pct(mean)} · ${durations.length} parties en ${((Date.now() - t0) / 1000).toFixed(0)} s · durée médiane ${mmss(med(durations))}`
  );
  await setHead(
    `BGEW WAR — entraînement · génération <b>${state.generation}</b>`,
    `meilleur <b>${pct(rate(best))}</b> (#${best.id}) · moyenne ${pct(mean)} · <b>${state.totalGames}</b> parties jouées`
  );
  // panthéon : le champion y entre toutes les 3 générations (8 derniers gardés)
  if (state.generation % 3 === 0) {
    state.hall.push({ generation: state.generation, genome: clone(champion().genome) });
    if (state.hall.length > 8) state.hall.shift();
  }
  // relève : le quart de tête survit, le reste = enfants des meilleurs
  const elites = pop.slice(0, Math.max(2, Math.round(pop.length / 4)));
  const parents = pop.slice(0, Math.max(3, Math.round(pop.length / 2)));
  const next = [...elites];
  while (next.length < POP) {
    const a = parents[Math.floor(rnd() * parents.length)];
    const b = parents[Math.floor(rnd() * parents.length)];
    next.push(indiv(mutate(cross(a.genome, b.genome)), `enfant g${state.generation}`));
  }
  state.population = next;
  await writeFile(STATE_FILE, JSON.stringify(state));
  await exportChampion(false);
}

/** Écrit le champion dans src/trained.ts (l'IA du jeu l'importe). */
async function exportChampion(verbose) {
  const c = champion();
  const body = `/**
 * Génome ENTRAÎNÉ par auto-jeu — fichier généré par tools/train.mjs, ne pas
 * modifier à la main (relancer l'entraînement). Génération ${state.generation},
 * ${state.totalGames} parties jouées, score ${pct(rate(c))} contre ses adversaires d'entraînement.
 */
import type { Genome } from "./commander";

export const TRAINED_GENERATION = ${state.generation};

export const TRAINED_GENOME: Genome = ${JSON.stringify(c.genome, (k, v) => (typeof v === "number" ? +v.toFixed(3) : v), 2)};
`;
  await writeFile(join(ROOT, "src/trained.ts"), body);
  if (verbose) console.log(`Champion #${c.id} (${pct(rate(c))}) écrit dans src/trained.ts`);
}

/** Bilan : le champion contre chaque style fixe, les deux couleurs. */
async function validate() {
  const c = champion();
  const me = { name: "CHAMPION", genome: c.genome };
  const jobs = [];
  for (const s of SPARRING) {
    for (let k = 0; k < 6; k++) {
      const opp = { name: s, genome: meta.styles[s] };
      jobs.push({ s, asRed: k % 2 === 0, red: k % 2 === 0 ? me : opp, blue: k % 2 === 0 ? opp : me, seed: 9000 + k * 77 + s.length * 13 });
    }
  }
  await setHead(`BGEW WAR — <b>bilan du champion</b> (génération ${state.generation})`, `#${c.id}`);
  const results = await runJobs(jobs);
  const by = {};
  results.forEach((r, k) => {
    if (!r) return;
    const j = jobs[k];
    const mine = j.asRed ? 1 : 2;
    (by[j.s] ||= [0, 0])[0] += r.winner === mine ? 1 : r.winner === 0 ? 0.5 : 0;
    by[j.s][1]++;
  });
  let tot = 0;
  let n = 0;
  console.log("\nChampion contre les styles fixes :");
  for (const s of SPARRING) {
    if (!by[s]) continue;
    tot += by[s][0];
    n += by[s][1];
    console.log(`  ${s.padEnd(10)} ${pct(by[s][0] / by[s][1])}  (${by[s][1]} parties)`);
  }
  if (n) console.log(`  ${"TOTAL".padEnd(10)} ${pct(tot / n)}`);
}

async function shutdown() {
  if (state.generation > 0) {
    await writeFile(STATE_FILE, JSON.stringify(state));
    await exportChampion(true);
  }
  await Promise.all(closers.map((c) => c().catch(() => {})));
  server.close();
}
// Ctrl+C ou arrêt de la tâche : on finit proprement (état sauvé, champion exporté).
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\nArrêt demandé : je sauve l'état et j'exporte le champion…");
  });
}

// --snap fichier.png : capture du premier mur après 25 s (vérification sans regarder l'écran)
if (SHOW && arg("snap", "")) {
  setTimeout(() => walls[0]?.screenshot({ path: arg("snap", "") }).catch((e) => console.log("capture impossible :", e.message)), 25000);
}

console.log(`${workers.length} batailles en parallèle · population ${POP} · ${MATCHES} parties par génome et par génération${GENERATIONS ? ` · ${GENERATIONS} générations` : " · jusqu'à Ctrl+C"}`);
await setHead("BGEW WAR — entraînement par auto-jeu", `population ${POP}`);
const target = GENERATIONS ? state.generation + GENERATIONS : Infinity;
while (!stopping && state.generation < target) await generation();
if (!stopping && !flag("no-validate")) await validate();
await shutdown();
process.exit(0);
