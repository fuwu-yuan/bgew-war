/** Capture the boot splash at several moments → /tmp/splash-*.png. */
import http from "http";
import { readFile } from "fs/promises";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8769;
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
const page = await browser.newPage({ viewport: { width: 640, height: 1024 } });
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`CONSOLE: ${m.text()}`); });

// firebase=off (no auth noise) but splash ON.
await page.goto(`http://localhost:${PORT}/?firebase=off`, { waitUntil: "domcontentloaded" });
const shots = [600, 1450, 1700, 2300, 3000];
let prev = 0;
for (const ms of shots) {
  await page.waitForTimeout(ms - prev);
  prev = ms;
  await page.screenshot({ path: `/tmp/splash-${ms}.png` });
}
await browser.close();
server.close();
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "No console/page errors ✓");
