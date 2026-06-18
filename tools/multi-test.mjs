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
const GAME_URL = `http://localhost:${PORT}/?server=localhost:${NET_PORT}&firebase=off&splash=off`;

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

const a = await openPage("A");
const b = await openPage("B");

// Quick match: A searches first (creates a room), B searches ~1.5s later and
// auto-joins it. The creator (A) then presses COMMENCER to launch. The host
// (blue) was drawn at room creation, so we detect roles afterwards.
await a.page.mouse.click(...a.at(320, 599)); // MULTIJOUEUR
await a.page.waitForTimeout(700);
await a.page.mouse.click(...a.at(320, 348)); // PARTIE RAPIDE
await a.page.waitForTimeout(1600);
await a.page.screenshot({ path: "/tmp/bgew-war-mp-1-search.png" });

await b.page.mouse.click(...b.at(320, 599)); // MULTIJOUEUR
await b.page.waitForTimeout(700);
await b.page.mouse.click(...b.at(320, 348)); // PARTIE RAPIDE

// They pair up — A (creator) should now be in the salon with the opponent.
await a.page.waitForTimeout(2800);
const salonA = await a.page.evaluate(() => window.__bgewwar.board.step.name);
if (salonA !== "salon") errors.push(`FLOW: creator A should be in salon, got "${salonA}"`);
await a.page.screenshot({ path: "/tmp/bgew-war-mp-2-salon.png" });

// Creator launches the match manually (no auto-start).
await a.page.mouse.click(...a.at(320, 496)); // COMMENCER LA PARTIE
await a.page.waitForTimeout(2500);
const stepA = await a.page.evaluate(() => window.__bgewwar.board.step.name);
const stepB = await b.page.evaluate(() => window.__bgewwar.board.step.name);
if (stepA !== "game") errors.push(`FLOW: page A should be in game, got "${stepA}"`);
if (stepB !== "game") errors.push(`FLOW: page B should be in game, got "${stepB}"`);

// Random host draw → figure out which page is the game host / guest.
const roleA = await a.page.evaluate(() => window.__bgewwar.steps.play.role);
const roleB = await b.page.evaluate(() => window.__bgewwar.steps.play.role);
console.log(`roles: A=${roleA} B=${roleB}`);
if (!((roleA === "host" && roleB === "guest") || (roleA === "guest" && roleB === "host"))) {
  errors.push(`FLOW: expected one host + one guest, got A=${roleA} B=${roleB}`);
}
const host = roleA === "host" ? a : b;
const guest = roleA === "host" ? b : a;

await host.page.screenshot({ path: "/tmp/bgew-war-mp-3-host-game.png" });
await guest.page.screenshot({ path: "/tmp/bgew-war-mp-4-guest-game.png" });

// Let the war breathe, then the guest (RED) acts: barracks on a northern
// red tile, then the attack axis on column 12
await guest.page.waitForTimeout(4000);
await guest.page.mouse.click(...guest.at(157, 992)); // CASERNE
await guest.page.waitForTimeout(300);
// The guest's view is mirrored: their red territory is at the BOTTOM
await guest.page.mouse.click(...guest.at(280, 700));
await guest.page.waitForTimeout(800);
await guest.page.mouse.click(...guest.at(587, 992)); // AXE
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
// Lockstep: the guest now runs its OWN sim (no `remote` mirror), so it has
// real units/buildings just like the host.
const guestUnits = await guest.page.evaluate(() => window.__bgewwar.steps.play.units.filter((u) => !u.dead).length);
console.log(`guest sim units: ${guestUnits}`);
if (guestUnits < 5) errors.push(`SYNC: guest only has ${guestUnits} units`);

// Lockstep: the SIM is now identical (host space) on both clients — the mirror
// is render-only. So the red HQ row must MATCH (the guest just draws it flipped).
const hostHqRow = await host.page.evaluate(
  () => window.__bgewwar.steps.play.buildings.find((b) => b.type === "hq" && b.faction === 1)?.row
);
const guestHqRow = await guest.page.evaluate(
  () => window.__bgewwar.steps.play.buildings.find((b) => b.type === "hq" && b.faction === 1)?.row
);
console.log(`red HQ row: host=${hostHqRow} guest=${guestHqRow} (identical sim, render-only mirror)`);
if (guestHqRow !== hostHqRow) {
  errors.push(`SIM: red HQ row should match host-space on both (host ${hostHqRow}, guest ${guestHqRow})`);
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
