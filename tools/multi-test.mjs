/**
 * Headless multiplayer test: BGEW server + game server + TWO Chromium pages.
 * The host creates a room, the guest joins from the lobby list, the war runs,
 * the guest (red) builds and upgrades, then the host disconnects and the
 * guest must win by forfeit. Screenshots: /tmp/bgew-war-mp-*.png.
 *
 * Usage: node tools/multi-test.mjs [path-to-chromium]
 */
import http from "http";
import { spawn } from "child_process";
import { readFile } from "fs/promises";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8767;
const NET_PORT = 8768;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".map": "application/json",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

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

const netServer = spawn(process.execPath, [join(ROOT, "tools", "server.mjs"), String(NET_PORT)], {
  stdio: ["ignore", "inherit", "inherit"],
});
await new Promise((r) => setTimeout(r, 700));

const executablePath =
  process.argv[2] ||
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const browser = await chromium.launch({ executablePath, args: ["--autoplay-policy=no-user-gesture-required"] });
const errors = [];
const GAME_URL = `http://localhost:${PORT}/?server=localhost:${NET_PORT}`;

async function openPage(tag) {
  const page = await browser.newPage({ viewport: { width: 700, height: 1080 } });
  page.on("pageerror", (e) => errors.push(`${tag} PAGEERROR: ${e.stack || e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${tag} CONSOLE: ${m.text()}`);
  });
  await page.goto(GAME_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const canvas = await page.locator("#game canvas").boundingBox();
  const scale = canvas.width / 640;
  const at = (x, y) => [canvas.x + x * scale, canvas.y + y * scale];
  return { page, at };
}

const host = await openPage("HOST");
const guest = await openPage("GUEST");

// Host: MULTIJOUEUR → CREER UNE PARTIE → waiting room (salon)
await host.page.mouse.click(...host.at(320, 599));
await host.page.waitForTimeout(900);
await host.page.mouse.click(...host.at(320, 308));
await host.page.waitForTimeout(1200);
await host.page.screenshot({ path: "/tmp/bgew-war-mp-1-host-salon.png" });
const hostStep = await host.page.evaluate(() => window.__bgewwar.board.step.name);
if (hostStep !== "salon") errors.push(`FLOW: host should be in the salon, got "${hostStep}"`);

// Guest: MULTIJOUEUR → list shows the room → join it → salon too
await guest.page.mouse.click(...guest.at(320, 599));
await guest.page.waitForTimeout(900);
await guest.page.mouse.click(...guest.at(320, 380)); // ACTUALISER
await guest.page.waitForTimeout(700);
await guest.page.screenshot({ path: "/tmp/bgew-war-mp-2-guest-list.png" });
await guest.page.mouse.click(...guest.at(320, 464)); // first room button
await guest.page.waitForTimeout(1500);
await guest.page.screenshot({ path: "/tmp/bgew-war-mp-2b-guest-salon.png" });
const guestStep = await guest.page.evaluate(() => window.__bgewwar.board.step.name);
if (guestStep !== "salon") errors.push(`FLOW: guest should be in the salon, got "${guestStep}"`);
await host.page.screenshot({ path: "/tmp/bgew-war-mp-2c-host-salon-full.png" });

// Host launches the war from the salon
await host.page.mouse.click(...host.at(320, 520)); // LANCER LA PARTIE
await host.page.waitForTimeout(1800);

await host.page.screenshot({ path: "/tmp/bgew-war-mp-3-host-game.png" });
await guest.page.screenshot({ path: "/tmp/bgew-war-mp-4-guest-game.png" });

// Let the war breathe, then the guest (RED) acts: barracks on a northern
// red tile, then the attack axis on column 12
await guest.page.waitForTimeout(4000);
await guest.page.mouse.click(...guest.at(65, 992)); // CASERNE
await guest.page.waitForTimeout(300);
// The guest's view is mirrored: their red territory is at the BOTTOM
await guest.page.mouse.click(...guest.at(280, 700));
await guest.page.waitForTimeout(800);
await guest.page.mouse.click(...guest.at(593, 992)); // AXE
await guest.page.waitForTimeout(300);
await guest.page.mouse.click(...guest.at(500, 420));
await guest.page.waitForTimeout(6000);
await guest.page.screenshot({ path: "/tmp/bgew-war-mp-5-guest-combat.png" });
await host.page.screenshot({ path: "/tmp/bgew-war-mp-6-host-combat.png" });

// Consistency probe: same blue share on both sides (±3 pts)
const hostShare = await host.page.evaluate(() => window.__bgewwar.steps.play.blueShare);
const guestShare = await guest.page.evaluate(() => window.__bgewwar.steps.play.blueShare);
console.log(`share host=${(hostShare * 100).toFixed(1)}% guest=${(guestShare * 100).toFixed(1)}%`);
if (Math.abs(hostShare - guestShare) > 0.03) {
  errors.push(`SYNC: share mismatch host=${hostShare} guest=${guestShare}`);
}
const guestUnits = await guest.page.evaluate(() => {
  const play = window.__bgewwar.steps.play;
  return play.remote ? play.remote.units.size : -1;
});
console.log(`guest sees ${guestUnits} remote units`);
if (guestUnits < 5) errors.push(`SYNC: guest only sees ${guestUnits} units`);

// Mirror check: the red HQ sits near the top for the host and near the
// bottom for the guest (rows must be vertical mirrors of each other)
const hostHqRow = await host.page.evaluate(
  () => window.__bgewwar.steps.play.buildings.find((b) => b.type === "hq" && b.faction === 1)?.row
);
const guestHqRow = await guest.page.evaluate(
  () => [...window.__bgewwar.steps.play.remote.buildings.values()].find((b) => b.type === "hq" && b.faction === 1)?.row
);
console.log(`red HQ row: host=${hostHqRow} guest=${guestHqRow} (mirror of ${hostHqRow} is ${23 - hostHqRow})`);
if (guestHqRow !== 23 - hostHqRow) {
  errors.push(`FLIP: red HQ should be mirrored (host row ${hostHqRow}, guest row ${guestHqRow})`);
}

// Host leaves → the guest must win by forfeit
await host.page.close();
await guest.page.waitForTimeout(4500);
await guest.page.screenshot({ path: "/tmp/bgew-war-mp-7-guest-forfeit.png" });

console.log(errors.length ? `\n${errors.length} error(s):\n` + errors.slice(0, 12).join("\n") : "No errors ✓");
await browser.close();
server.close();
netServer.kill();
process.exit(errors.length ? 1 : 0);
