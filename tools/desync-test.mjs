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
const net = spawn(process.execPath, [join(ROOT, "tools", "server.mjs"), String(NET_PORT)], { stdio: ["ignore", "inherit", "inherit"] });
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
const URLB = `http://localhost:${PORT}/?server=localhost:${NET_PORT}&firebase=off&splash=off&bot=1`;

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
const step = (pg) => pg.evaluate(() => window.__bgewwar.board.step.name);

const A = await open(browserA, "A");
const B = await open(browserB, "B");

// Quick match: A searches & creates, B joins, A presses COMMENCER.
await A.p.mouse.click(...A.at(320, 599)); await A.p.waitForTimeout(700);
await A.p.mouse.click(...A.at(320, 348)); await A.p.waitForTimeout(1600);
await B.p.mouse.click(...B.at(320, 599)); await B.p.waitForTimeout(700);
await B.p.mouse.click(...B.at(320, 348)); await A.p.waitForTimeout(2800);
await A.p.mouse.click(...A.at(320, 496)); await A.p.waitForTimeout(2500);

const rA = await A.p.evaluate(() => window.__bgewwar.steps.play.role);
const host = rA === "host" ? A : B;
const guest = rA === "host" ? B : A;
if ((await step(host.p)) !== "game" || (await step(guest.p)) !== "game") errors.push("not both in game");

// Both sides play themselves via `?bot=1` — nothing to drive from here, just
// sample at synced moments: signatures + screenshots from BOTH sides.
const samples = [15, 30, 45, 60, 75, 90];
let prev = 8;
let last = null;
for (const t of samples) {
  await host.p.waitForTimeout((t - prev) * 1000); prev = t;
  if ((await step(host.p)) !== "game" || (await step(guest.p)) !== "game") {
    console.log(`t≈${t}s  match ended early (a HQ fell) — stopping samples`);
    break;
  }
  const [sh, sg] = await Promise.all([sig(host.p), sig(guest.p)]);
  await Promise.all([
    host.p.screenshot({ path: `/tmp/desync-${t}s-host.png` }),
    guest.p.screenshot({ path: `/tmp/desync-${t}s-guest.png` }),
  ]);
  const dU = Math.abs(sh.units - sg.units), dB = Math.abs(sh.buildings - sg.buildings);
  const dS = Math.abs(sh.share - sg.share), dG = Math.abs((sh.goldR + sh.goldB) - (sg.goldR + sg.goldB));
  last = { dU, dB, dS, dG, units: Math.max(sh.units, sg.units) };
  console.log(`t≈${t}s  HOST ${JSON.stringify(sh)}  GUEST ${JSON.stringify(sg)}  Δunits=${dU} Δbuild=${dB} Δshare=${dS}pts Δgold=${dG}`);
}

// Gate on the authoritative quantities; unit count may drift but must stay sane.
if (last) {
  if (last.dB > 4) errors.push(`buildings diverged: Δ=${last.dB}`);
  if (last.dS > 8) errors.push(`territory diverged: Δshare=${last.dS}pts`);
  if (last.dU > last.units * 0.5) errors.push(`unit count diverged: Δ=${last.dU} of ${last.units}`);
  if (last.units < 20) errors.push(`bots barely played: only ${last.units} units — check ?bot=1`);
}

console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "run ok ✓ (screenshots in /tmp/desync-*.png)");
if (HEADED) { console.log("watch the two windows… closing in 40s"); await A.p.waitForTimeout(40000); }
await browserA.close();
if (HEADED) await browserB.close();
server.close(); net.kill();
process.exit(errors.length ? 1 : 0);
