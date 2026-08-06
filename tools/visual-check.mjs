/** One-off visual check for the v1.5.0 UI additions (names in battle, MES STATS
 *  modal, menu bottom row). Saves PNGs to /tmp/vc-*.png. firebase=off → the
 *  stats modal shows its "not connected" state. */
import http from "http";
import { readFile } from "fs/promises";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8767;
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

const executablePath = process.argv[2] || `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const browser = await chromium.launch({ executablePath, args: ["--autoplay-policy=no-user-gesture-required"] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 760, height: 1100 } });
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`CONSOLE: ${m.text()}`); });

await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off`, { waitUntil: "networkidle" });
await page.waitForTimeout(1800);
const canvas = await page.locator("#game canvas").boundingBox();
const scale = canvas.width / 640;
const at = (x, y) => [canvas.x + x * scale, canvas.y + y * scale];

await page.screenshot({ path: "/tmp/vc-1-menu.png" });

// MES STATS button (bottom-left row, y≈901)
await page.mouse.click(...at(165, 901));
await page.waitForTimeout(700);
await page.screenshot({ path: "/tmp/vc-2-stats-modal.png" });
// close via Escape
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Start a solo game → names in battle (Vous vs IA)
await page.mouse.click(...at(320, 533));
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/vc-2b-difficulty.png" });
await page.mouse.click(...at(320, 633)); // MOYEN
await page.waitForTimeout(1200);
await page.screenshot({ path: "/tmp/vc-3-battle-names.png" });

await browser.close();
server.close();
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "No console/page errors ✓");
