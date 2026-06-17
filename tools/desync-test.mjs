/**
 * Desync harness: two Chromium clients play one quick match. At fixed moments
 * it (a) dumps each side's flip-invariant state signature (units/buildings/gold/
 * share) for a PRECISE divergence check, and (b) screenshots BOTH sides into
 * /tmp/desync-*.png for visual (AI) analysis — pixel diff is meaningless since
 * the guest's view is vertically mirrored and cosmetics are random.
 *
 * Baseline (host-authoritative): host & guest signatures should match closely
 * (the guest mirrors the host). Once the guest runs its own sim, this is the
 * gate that tells us whether the two simulations stay in sync.
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
const URLB = `http://localhost:${PORT}/?server=localhost:${NET_PORT}&firebase=off&splash=off`;

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

// BOTH players issue an AXE order periodically — keeps each "active" (so the
// anti-AFK rule doesn't void the match) and exercises the command path.
const axis = async (c) => { await c.p.mouse.click(...c.at(587, 992)); await c.p.waitForTimeout(200); await c.p.mouse.click(...c.at(320, 360)); };

// Sample at synced moments: signatures + screenshots from BOTH sides.
const samples = [12, 25, 40, 55];
let prev = 8;
for (const t of samples) {
  await axis(host); await axis(guest); // stay active on both sides
  await host.p.waitForTimeout((t - prev) * 1000); prev = t;
  const [sh, sg] = await Promise.all([sig(host.p), sig(guest.p)]);
  await Promise.all([
    host.p.screenshot({ path: `/tmp/desync-${t}s-host.png` }),
    guest.p.screenshot({ path: `/tmp/desync-${t}s-guest.png` }),
  ]);
  const dU = Math.abs(sh.units - sg.units), dB = Math.abs(sh.buildings - sg.buildings), dS = Math.abs(sh.share - sg.share);
  console.log(`t≈${t}s  HOST ${JSON.stringify(sh)}  GUEST ${JSON.stringify(sg)}  Δunits=${dU} Δbuild=${dB} Δshare=${dS}`);
}

console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "run ok ✓ (screenshots in /tmp/desync-*.png)");
if (HEADED) { console.log("watch the two windows… closing in 40s"); await A.p.waitForTimeout(40000); }
await browserA.close();
if (HEADED) await browserB.close();
server.close(); net.kill();
