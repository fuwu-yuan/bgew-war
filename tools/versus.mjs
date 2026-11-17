/**
 * Face-à-face de deux génomes (fichiers au format src/trained.ts), côtés alternés,
 * puis chacun contre les styles de référence.
 * Usage : node tools/versus.mjs <A.ts> <B.ts> [--matches 100] [--panel 12] [--workers 10]
 */
import http from "http";
import { readFile } from "fs/promises";
import { readFileSync, readdirSync } from "fs";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
const files = args.filter((a, i) => !a.startsWith("--") && !(args[i - 1] || "").startsWith("--"));
const MATCHES = opt("matches", 100), PANEL = opt("panel", 12), WORKERS = opt("workers", 10);
const genomeOf = (f) => JSON.parse(readFileSync(f, "utf8").match(/TRAINED_GENOME: Genome = (\{[\s\S]*\});/)[1]);
const [A, B] = files.map(genomeOf);
const REFS = ["infantry", "expander", "armor", "bomber", "mixed", "fortress", "air", "no_tank"];

const PORT = 8600 + Math.floor(Math.random() * 90);
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

// file de parties : { red, blue, seed, tag, aRed }
const jobs = [];
for (let i = 0; i < MATCHES; i++) jobs.push({ tag: "h2h", seed: 9000 + (i >> 1) * 17, red: i % 2 ? B : A, blue: i % 2 ? A : B, aRed: i % 2 === 0 });
for (const [name, g] of [["A", A], ["B", B]])
  for (const s of REFS)
    for (let i = 0; i < PANEL; i++) jobs.push({ tag: `${name}:${s}`, seed: 500 + (i >> 1) * 31, red: i % 2 ? s : g, blue: i % 2 ? g : s, aRed: i % 2 === 0 });

const out = [];
let next = 0;
await Promise.all(Array.from({ length: WORKERS }, async () => {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.evaluate(pageJs);
  while (next < jobs.length) {
    const j = jobs[next++];
    await page.evaluate((o) => window.__lab.begin(o), { red: j.red, blue: j.blue, seed: j.seed, maxSeconds: 540 });
    let r = null;
    while (!r) r = await page.evaluate(() => window.__lab.run(2400));
    // victoire du génome testé : 1, nul : 0.5, défaite : 0   (rouge = 1, bleu = 2 côté banc)
    const redWon = r.winner === 1, draw = r.winner === 0;
    out.push({ tag: j.tag, score: draw ? 0.5 : redWon === j.aRed ? 1 : 0, t: r.t, redWon, draw });
  }
  await page.close();
}));
await browser.close();
server.close();

const sum = (tag) => { const m = out.filter((o) => o.tag === tag); return { n: m.length, w: m.filter((o) => o.score === 1).length, d: m.filter((o) => o.draw).length, l: m.filter((o) => o.score === 0).length, t: m.map((o) => o.t).sort((a, b) => a - b)[m.length >> 1] }; };
const h = sum("h2h");
console.log(`A = ${files[0]}\nB = ${files[1]}\n`);
console.log(`Face-à-face (${h.n} parties, côtés alternés) : A ${h.w} victoires · ${h.d} nuls · B ${h.l} victoires · durée médiane ${Math.floor(h.t / 60)}:${String(h.t % 60).padStart(2, "0")}`);
const reds = out.filter((o) => o.tag === "h2h" && o.redWon).length;
console.log(`  (dont victoires du camp rouge : ${reds}/${h.n})\n`);
console.log("Contre les styles de référence (victoires / parties) :");
let ta = 0, tb = 0;
for (const s of REFS) { const a = sum(`A:${s}`), b = sum(`B:${s}`); ta += a.w + a.d / 2; tb += b.w + b.d / 2; console.log(`  ${s.padEnd(10)} A ${a.w}/${a.n}   B ${b.w}/${b.n}`); }
console.log(`  TOTAL      A ${(100 * ta / (REFS.length * PANEL)).toFixed(0)} %   B ${(100 * tb / (REFS.length * PANEL)).toFixed(0)} %`);
