/**
 * Headless smoke test: serves the game, plays it in Chromium on a desktop
 * viewport AND an iPhone-like touch viewport, saves screenshots to
 * /tmp/bgew-war-*.png and fails on any console/page error.
 *
 * Usage: node tools/smoke-test.mjs [path-to-chromium]
 */
import http from "http";
import { readFile } from "fs/promises";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium, devices } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8766;
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

const executablePath =
  process.argv[2] ||
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const browser = await chromium.launch({ executablePath, args: ["--autoplay-policy=no-user-gesture-required"] });
const errors = [];

/* ------------------------------------------------------------------ *
 * Desktop run — click through menu, build, set axis, let the war run
 * ------------------------------------------------------------------ */
{
  const page = await browser.newPage({ viewport: { width: 760, height: 1100 } });
  page.on("pageerror", (e) => errors.push(`DESKTOP PAGEERROR: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`DESKTOP CONSOLE: ${m.text()}`);
  });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: "/tmp/bgew-war-1-menu.png" });

  const canvas = await page.locator("#game canvas").boundingBox();
  if (!canvas) throw new Error("canvas not found");
  // The canvas is scaled: convert game coords -> page coords
  const scale = canvas.width / 640;
  const at = (x, y) => [canvas.x + x * scale, canvas.y + y * scale];

  // Help panel open/close
  await page.mouse.click(...at(320, 658));
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/bgew-war-2-help.png" });
  await page.mouse.click(...at(320, 880));
  await page.waitForTimeout(400);

  // JOUER
  await page.mouse.click(...at(320, 533));
  await page.waitForTimeout(1400);
  await page.screenshot({ path: "/tmp/bgew-war-3-game-start.png" });

  // Let the front move, then build a barracks bottom middle
  await page.waitForTimeout(4000);
  await page.mouse.click(...at(65, 992)); // CASERNE button
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/bgew-war-4-build-mode.png" });
  await page.mouse.click(...at(320, 700)); // blue tile mid-south
  await page.waitForTimeout(400);

  // Attack axis on column 3
  await page.mouse.click(...at(593, 992)); // AXE button
  await page.waitForTimeout(200);
  await page.mouse.click(...at(140, 480));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "/tmp/bgew-war-5-combat.png" });

  // Soldier upgrade once the gold is there
  await page.waitForTimeout(8000);
  await page.mouse.click(...at(329, 992)); // SOLDATS+ button
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/bgew-war-5b-upgrade.png" });

  // Airstrike on the middle of the front
  await page.waitForTimeout(6000);
  await page.mouse.click(...at(505, 992)); // FRAPPE button
  await page.waitForTimeout(250);
  await page.mouse.click(...at(320, 440));
  await page.waitForTimeout(1300);
  await page.screenshot({ path: "/tmp/bgew-war-5c-strike.png" });

  // Helicopter sortie along a column (gold topped up to guarantee the buy)
  await page.evaluate(() => {
    window.__bgewwar.steps.play.gold[2] += 120;
  });
  await page.mouse.click(...at(417, 992)); // HELICO button
  await page.waitForTimeout(250);
  await page.mouse.click(...at(200, 500)); // flight lane
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "/tmp/bgew-war-5d-helico.png" });
  const heli = await page.evaluate(() => {
    const play = window.__bgewwar.steps.play;
    return play.helis.filter((h) => !h.dead).length;
  });
  if (heli < 1) errors.push("HELICO: no helicopter in flight 2.5s after the order");

  // Long-run stability: 12 more seconds of war
  await page.waitForTimeout(12000);
  await page.screenshot({ path: "/tmp/bgew-war-6-late.png" });

  // Anti-rush sanity: ~35 s of casual play must not decide the war,
  // and the AI must have been spending its gold
  const ai = await page.evaluate(() => {
    const play = window.__bgewwar.steps.play;
    return {
      ended: play.ended,
      redBuildings: play.buildings.filter((b) => b.faction === 1 && !b.dead).length,
      redLevel: play.levels[1],
      redGold: Math.round(play.gold[1]),
    };
  });
  console.log(`AI state after ~35s: ${JSON.stringify(ai)}`);
  if (ai.ended) errors.push("BALANCE: the solo war was already decided after ~35 s");
  // The AI must be using its income: building, upgrading or garrisoning
  // (anything but hoarding)
  if (ai.redBuildings <= 6 && ai.redLevel === 1 && ai.redGold > 160) {
    errors.push(`BALANCE: red AI is hoarding gold without spending (${JSON.stringify(ai)})`);
  }

  // Anti-rush stress test: drop 15 fresh blue soldiers AT the red HQ.
  // Fortress gun + garrison + axis recall must hold the castle.
  const spawned = await page.evaluate(() => {
    const play = window.__bgewwar.steps.play;
    const hq = play.buildings.find((b) => b.type === "hq" && b.faction === 1 && !b.dead);
    if (!hq) return -1;
    const before = play.units.filter((u) => u.faction === 2).length;
    for (let i = 0; i < 15; i++) {
      play.spawnSoldier(2, hq.cx + (Math.random() * 160 - 80), hq.cy + 90 + Math.random() * 70);
    }
    return play.units.filter((u) => u.faction === 2).length - before;
  });
  await page.waitForTimeout(12000);
  const rush = await page.evaluate(() => {
    const play = window.__bgewwar.steps.play;
    const hq = play.buildings.find((b) => b.type === "hq" && b.faction === 1);
    return { hqAlive: !!hq && !hq.dead, hqHp: hq ? Math.round(hq.hp) : 0, ended: play.ended };
  });
  console.log(`rush test: ${spawned} soldiers dropped on the HQ → ${JSON.stringify(rush)}`);
  await page.screenshot({ path: "/tmp/bgew-war-6b-rush.png" });
  if (!rush.hqAlive || rush.ended) errors.push(`BALANCE: a 15-soldier rush still kills the HQ (${JSON.stringify(rush)})`);

  const fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const t0 = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
          else resolve(Math.round((frames / (performance.now() - t0)) * 1000));
        };
        requestAnimationFrame(tick);
      })
  );
  console.log(`desktop rAF fps ≈ ${fps}`);

  // Force the red HQ down to trigger the victory flow, then replay
  // (skip the kill if the war already ended on its own)
  await page.evaluate(() => {
    const play = window.__bgewwar.steps.play;
    const hq = play.buildings.find((b) => b.type === "hq" && b.faction === 1 && !b.dead);
    if (hq && !play.ended) play.notifyKill(hq, 2);
  });
  await page.waitForTimeout(3600);
  await page.screenshot({ path: "/tmp/bgew-war-7-victory.png" });
  await page.mouse.click(...at(320, 688)); // REJOUER
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/tmp/bgew-war-8-replay.png" });
  await page.close();
}

/* ------------------------------------------------------------------ *
 * Mobile run — iPhone viewport, touch taps only
 * ------------------------------------------------------------------ */
{
  const iphone = devices["iPhone 13"];
  const page = await browser.newPage({ ...iphone, hasTouch: true, isMobile: true });
  page.on("pageerror", (e) => errors.push(`MOBILE PAGEERROR: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`MOBILE CONSOLE: ${m.text()}`);
  });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: "/tmp/bgew-war-m1-menu.png" });

  const canvas = await page.locator("#game canvas").boundingBox();
  if (!canvas) throw new Error("mobile canvas not found");
  const scale = canvas.width / 640;
  const at = (x, y) => [canvas.x + x * scale, canvas.y + y * scale];

  // Tap JOUER
  await page.touchscreen.tap(...at(320, 533));
  await page.waitForTimeout(1400);
  await page.screenshot({ path: "/tmp/bgew-war-m2-game.png" });

  // Tap TOURELLE then a southern blue tile — also proves touch coords
  // survive the HiDPI buffer (deviceScaleFactor 3 on this viewport)
  await page.touchscreen.tap(...at(153, 992));
  await page.waitForTimeout(250);
  await page.touchscreen.tap(...at(280, 760));
  await page.waitForTimeout(5000);
  await page.screenshot({ path: "/tmp/bgew-war-m3-combat.png" });
  const turrets = await page.evaluate(() => {
    const play = window.__bgewwar.steps.play;
    return play.buildings.filter((b) => b.type === "turret" && b.faction === 2 && !b.dead).length;
  });
  // 2 starting turrets + the tapped one
  if (turrets < 3) errors.push(`MOBILE: turret tap did not land, ${turrets} turret(s) (HiDPI input regression?)`);
  const buf = await page.evaluate(() => {
    const c = document.querySelector("#game canvas");
    return { w: c.width, cssW: Math.round(c.getBoundingClientRect().width), dpr: window.devicePixelRatio };
  });
  console.log(`mobile canvas: buffer ${buf.w}px for ${buf.cssW}px CSS (dpr ${buf.dpr})`);
  if (buf.w < buf.cssW * 2) errors.push(`HIDPI: buffer not upscaled (${JSON.stringify(buf)})`);
  await page.close();
}

console.log(errors.length ? `\n${errors.length} error(s):\n` + errors.slice(0, 12).join("\n") : "No console/page errors ✓");
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
