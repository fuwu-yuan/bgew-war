/**
 * Desync harness: two Chromium clients play one REAL quick match, both driven
 * by the in-game bot (`?bot=1`) — the solo AI's reflexes wired through the
 * command path. So the army grows, airstrikes land, helicos raid and upgrades
 * stack on both sides, exactly like two humans playing. At fixed moments it
 * (a) dumps each side's flip-invariant state signature (units/buildings/gold/
 * share) for a PRECISE divergence check, and (b) screenshots BOTH sides into
 * /tmp/desync-*.png for visual (AI) analysis — pixel diff is meaningless since
 * the guest's view is vertically mirrored and cosmetics are random.
 *
 * The lockstep gate: buildings, territory (share) and gold are authoritative /
 * corrected, so they must stay tight; unit COUNT is allowed to drift a little
 * (cosmetic per-unit RNG), but must stay bounded, not diverge.
 *
 * Usage: node tools/desync-test.mjs [path-to-chromium]
 */
import http from "http";
import { spawn } from "child_process";
import { readFile } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8767;
const NET_PORT = 8768;
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
// PROD=1 → use the real relay (wss://bgew.stevecohen.fr) instead of a local one.
const PROD = process.env.PROD === "1";
const net = PROD ? null : spawn(process.execPath, [join(ROOT, "tools", "server.mjs"), String(NET_PORT)], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 700));

// HEADED=1 → real visible windows (needs a FULL chromium, not the headless shell).
const HEADED = process.env.HEADED === "1";
function findFullChromium() {
  const base = `${process.env.HOME}/Library/Caches/ms-playwright`;
  for (const d of readdirSync(base).filter((x) => x.startsWith("chromium-")).sort().reverse()) {
    for (const sub of ["chrome-mac-arm64", "chrome-mac"]) {
      const p = `${base}/${d}/${sub}/Chromium.app/Contents/MacOS/Chromium`;
      if (existsSync(p)) return p;
    }
  }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}
const exe = process.argv[2] || (HEADED ? findFullChromium() : `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell`);
const errors = [];
// One browser per player so headed mode shows two side-by-side windows.
const launch = (x) =>
  chromium.launch({
    executablePath: exe,
    headless: !HEADED,
    args: ["--autoplay-policy=no-user-gesture-required", ...(HEADED ? [`--window-position=${x},20`, "--window-size=700,940"] : [])],
  });
const browserA = await launch(10);
const browserB = HEADED ? await launch(720) : browserA;
// PROD: `server=off` clears any cached override → the built-in wss prod relay.
const SERVER = PROD ? "off" : `localhost:${NET_PORT}`;
const URLB = `http://localhost:${PORT}/?server=${SERVER}&firebase=off&splash=off&bot=1&debug=1`;

async function open(browser, tag) {
  const p = await browser.newPage({ viewport: HEADED ? null : { width: 640, height: 1024 } });
  p.on("pageerror", (e) => errors.push(`${tag} ${e.message}`));
  await p.goto(URLB, { waitUntil: "networkidle" });
  await p.waitForTimeout(1000);
  const box = await p.locator("#game canvas").boundingBox();
  const scale = box.width / 640;
  return { p, at: (x, y) => [box.x + x * scale, box.y + y * scale] };
}
const sig = (pg) => pg.evaluate(() => window.__bgewwar.steps.play.simSignature());
// Atomic sig+unit-dump at ONE tick (so host & guest can be diffed unit-by-unit).
const probe = (pg) => pg.evaluate(() => ({ sig: window.__bgewwar.steps.play.simSignature(), dump: window.__bgewwar.steps.play.dumpUnits() }));
const step = (pg) => pg.evaluate(() => window.__bgewwar.board.step.name);
function firstDiffs(a, b, n = 6) {
  const A = a.split("|"), B = b.split("|"), out = [];
  const setB = new Set(B), setA = new Set(A);
  for (const r of A) if (!setB.has(r) && out.length < n) out.push(`H only: ${r}`);
  for (const r of B) if (!setA.has(r) && out.length < n) out.push(`G only: ${r}`);
  return out;
}

const A = await open(browserA, "A");
const B = await open(browserB, "B");

// Poll a predicate (handles real-network matchmaking latency, not just localhost).
async function until(fn, ms = 15000, every = 250) {
  for (let i = 0; i * every < ms; i++) { if (await fn()) return true; await A.p.waitForTimeout(every); }
  return false;
}

const code = (pg) => pg.evaluate(() => window.__bgewwar.board.step.code || null);

if (PROD) {
  // Shared prod server: quick-match would pair with stale/other rooms, so use a
  // PRIVATE room to pin A+B together. A creates → reads its code → B deep-links
  // into it (?join=CODE) → A (the creator) presses COMMENCER.
  await A.p.mouse.click(...A.at(320, 599)); await A.p.waitForTimeout(700); // MULTIJOUEUR
  await A.p.mouse.click(...A.at(320, 418)); await A.p.waitForTimeout(700); // PARTIE PRIVEE
  await A.p.mouse.click(...A.at(320, 346)); // CREER UNE PARTIE
  if (!(await until(async () => (await step(A.p)) === "salon" && (await code(A.p))))) errors.push("private room never created");
  const joinCode = await code(A.p);
  console.log(`private code = ${joinCode}`);
  await B.p.goto(`${URLB}&join=${joinCode}`, { waitUntil: "networkidle" }); // B deep-links into A's room
  if (!(await until(async () => (await step(A.p)) === "salon" && (await step(B.p)) === "salon"))) errors.push("guest never joined the private room");
  await A.p.waitForTimeout(500);
  await A.p.mouse.click(...A.at(320, 590)); // COMMENCER (private creator: y=564 + copy button above)
  if (!(await until(async () => (await step(A.p)) === "game" && (await step(B.p)) === "game"))) errors.push("not both in game");
} else {
  // Local relay: quick match. A searches & creates, B joins, A presses COMMENCER.
  await A.p.mouse.click(...A.at(320, 599)); await A.p.waitForTimeout(700);
  await A.p.mouse.click(...A.at(320, 348)); await A.p.waitForTimeout(1500);
  await B.p.mouse.click(...B.at(320, 599)); await B.p.waitForTimeout(700);
  await B.p.mouse.click(...B.at(320, 348));
  if (!(await until(async () => (await step(A.p)) === "salon"))) errors.push("matchmaking never paired (no salon)");
  await A.p.waitForTimeout(500);
  await A.p.mouse.click(...A.at(320, 496)); // COMMENCER (quick creator)
  if (!(await until(async () => (await step(A.p)) === "game" && (await step(B.p)) === "game"))) errors.push("not both in game");
}

const rA = await A.p.evaluate(() => window.__bgewwar.steps.play.role);
const host = rA === "host" ? A : B;
const guest = rA === "host" ? B : A;

// Both sides play themselves via `?bot=1` — nothing to drive from here, just
// sample at synced moments: signatures + screenshots from BOTH sides.
const samples = [15, 30, 45, 60, 75, 90];
let prev = 8;
let last = null;
let sawExact = false;
const ended = (pg) => pg.evaluate(() => window.__bgewwar.steps.play.ended || window.__bgewwar.board.step.name !== "game");
for (const t of samples) {
  await host.p.waitForTimeout((t - prev) * 1000); prev = t;
  if ((await ended(host.p)) || (await ended(guest.p))) {
    console.log(`t≈${t}s  match already decided (a HQ fell) — stopping samples`);
    break;
  }
  // Compare at the SAME sim tick: the host leads by ~INPUT_DELAY ticks, so
  // snapshot the host, then let the guest catch up to that exact tick. Now any
  // residual delta is true divergence, not the input-delay sampling offset.
  const ph = await probe(host.p);
  const sh = ph.sig;
  let pg = await probe(guest.p);
  for (let k = 0; k < 400 && pg.sig.tick < sh.tick; k++) {
    await guest.p.waitForTimeout(4); // poll fast so we land ON the host's tick
    pg = await probe(guest.p);
  }
  const sg = pg.sig;
  if (sh.tick === sg.tick && ph.dump !== pg.dump) {
    console.log(`  first unit diffs @tick ${sh.tick}:\n    ` + firstDiffs(ph.dump, pg.dump).join("\n    "));
  }
  await Promise.all([
    host.p.screenshot({ path: `/tmp/desync-${t}s-host.png` }),
    guest.p.screenshot({ path: `/tmp/desync-${t}s-guest.png` }),
  ]);
  const dU = Math.abs(sh.units - sg.units), dB = Math.abs(sh.buildings - sg.buildings);
  const dH = Math.abs(sh.helis - sg.helis);
  const dS = Math.abs(sh.share - sg.share), dG = Math.abs((sh.goldR + sh.goldB) - (sg.goldR + sg.goldB));
  const dTick = Math.abs(sh.tick - sg.tick); // the two reads land a few ticks apart
  last = { units: Math.max(sh.units, sg.units) };
  console.log(`t≈${t}s  HOST ${JSON.stringify(sh)}  GUEST ${JSON.stringify(sg)}  Δtick=${dTick} Δunits=${dU} Δheli=${dH} Δbuild=${dB} Δshare=${dS}pts Δgold=${dG}`);

  // True deterministic lockstep, checked PER SAMPLE. At the SAME tick the sims
  // must be BIT-EXACT (the proof). With a ±dTick skew a command (≤150 gold) or a
  // spawn can legitimately land in the gap, so deltas are bounded by the skew —
  // never by game size (the old best-effort model grew without bound).
  if (dTick === 0) {
    if (dU || dH || dB || dS || dG)
      errors.push(`t${t}: NOT bit-exact at equal tick: Δunits=${dU} Δheli=${dH} Δbuild=${dB} Δshare=${dS}pts Δgold=${dG}`);
    else sawExact = true;
  } else {
    if (dB > 2) errors.push(`t${t}: buildings diverged Δ=${dB} (Δtick=${dTick})`);
    if (dS > 3) errors.push(`t${t}: territory diverged Δshare=${dS}pts (Δtick=${dTick})`);
    if (dG > 160 * dTick + 4) errors.push(`t${t}: gold diverged Δ=${dG} (Δtick=${dTick})`);
    if (dU > 4 * dTick + 4) errors.push(`t${t}: units diverged Δ=${dU} (Δtick=${dTick})`);
  }
}
if (last && last.units < 20) errors.push(`bots barely played: only ${last.units} units — check ?bot=1`);
if (!sawExact) errors.push("never caught the two sims at the same tick — can't prove bit-exactness");

console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "run ok ✓ (screenshots in /tmp/desync-*.png)");
if (HEADED) { console.log("watch the two windows… closing in 40s"); await A.p.waitForTimeout(40000); }
await browserA.close();
if (HEADED) await browserB.close();
server.close(); if (net) net.kill();
process.exit(errors.length ? 1 : 0);
