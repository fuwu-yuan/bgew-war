/**
 * Duels isolés d'unités (sans production) : mesure la valeur d'échange.
 * Usage: node tools/balance-duel.mjs '<json rouge>' '<json bleu>' [variant.json] [essais]
 *   ex.  node tools/balance-duel.mjs '{"soldiers":40}' '{"tanks":6}'
 */
import http from "http";
import { readFile } from "fs/promises";
import { readdirSync } from "fs";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [redJ, blueJ, variant, trials = "8"] = process.argv.slice(2);
const overrides = variant && variant !== "-" ? JSON.parse(await readFile(variant, "utf8")) : null;
const PORT = 8500 + Math.floor(Math.random() * 90);
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
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.evaluate(await readFile(join(ROOT, "tools/balance-lab-page.js"), "utf8"));
// Plusieurs duels séparés par « ; » dans chaque argument (même nombre des deux côtés).
const reds = redJ.split(";").map((s) => JSON.parse(s));
const blues = blueJ.split(";").map((s) => JSON.parse(s));
for (let k = 0; k < reds.length; k++) {
  let rw = 0, rs = 0, bs = 0;
  for (let i = 0; i < Number(trials); i++) {
    // alterne les côtés pour annuler tout biais haut/bas
    const swap = i % 2 === 1;
    const r = await page.evaluate((o) => window.__lab.duel(o), { seed: 77 + i * 13, overrides, red: swap ? blues[k] : reds[k], blue: swap ? reds[k] : blues[k] });
    const a = swap ? r.blue : r.red, b = swap ? r.red : r.blue;
    if (a > b) rw++;
    rs += a; bs += b;
  }
  console.log(`${JSON.stringify(reds[k])} vs ${JSON.stringify(blues[k])} → A gagne ${rw}/${trials}, survivants moyens A ${(rs / trials).toFixed(1)} / B ${(bs / trials).toFixed(1)}`);
}
await browser.close();
server.close();
