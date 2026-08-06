/**
 * Banc d'essai des difficultés de l'IA solo : le bot de test (?bot=1, qui
 * joue BLEU comme un joueur moyen via le vrai chemin de commandes) affronte
 * l'IA rouge à chaque niveau. La sim est avancée à la main (simStep) pour
 * jouer plusieurs minutes de guerre en quelques secondes.
 *
 * Attendu : rouge s'améliore de facile → imbattable (part de carte, verdict).
 *
 * Usage: node tools/ai-bench.mjs [path-to-chromium] [matchesPerDiff]
 */
import http from "http";
import { readFile } from "fs/promises";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8768;
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
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const MATCHES = Number(process.argv[3] || 3);

const browser = await chromium.launch({ executablePath, args: ["--autoplay-policy=no-user-gesture-required"] });

/** y du centre de chaque bouton du sélecteur de difficulté. */
const DIFF_BTN = { easy: 579, medium: 633, hard: 687, insane: 741 };
const MAX_TICKS = 60 * 60 * 8; // 8 minutes de guerre max par match

async function playMatch(diff) {
  const page = await browser.newPage({ viewport: { width: 700, height: 1100 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off&bot=1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const canvas = await page.locator("#game canvas").boundingBox();
  const scale = canvas.width / 640;
  const at = (x, y) => [canvas.x + x * scale, canvas.y + y * scale];
  await page.mouse.click(...at(320, 533)); // JOUER
  await page.waitForTimeout(400);
  await page.mouse.click(...at(320, DIFF_BTN[diff]));
  await page.waitForTimeout(900);

  let out = null;
  for (let done = 0; done < MAX_TICKS && !out; done += 3600) {
    out = await page.evaluate(() => {
      const play = window.__bgewwar.steps.play;
      for (let i = 0; i < 3600 && !play.ended; i++) play.simStep();
      if (!play.ended) return null;
      return { t: Math.round(play.elapsed), share: play.blueShare, botWin: !!play.endData?.win };
    });
  }
  if (!out) {
    out = await page.evaluate(() => {
      const play = window.__bgewwar.steps.play;
      return { t: Math.round(play.elapsed), share: play.blueShare, botWin: null }; // nul (temps écoulé)
    });
  }
  await page.close();
  return { ...out, errors };
}

let failed = false;
const redWinRate = {};
for (const diff of ["easy", "medium", "hard", "insane"]) {
  let redWins = 0;
  let draws = 0;
  let shareSum = 0;
  for (let m = 0; m < MATCHES; m++) {
    const r = await playMatch(diff);
    if (r.errors.length) {
      failed = true;
      console.log(`  !! ${diff}: ${r.errors.join(" | ")}`);
    }
    if (r.botWin === null) draws++;
    else if (!r.botWin) redWins++;
    shareSum += r.share;
    console.log(`  ${diff} match ${m + 1}: ${r.botWin === null ? "nul" : r.botWin ? "BOT (bleu)" : "IA (rouge)"} en ${r.t}s — part bleue ${(r.share * 100).toFixed(0)}%`);
  }
  redWinRate[diff] = { wins: redWins, draws, share: shareSum / MATCHES };
  console.log(`${diff.toUpperCase()}: IA rouge ${redWins}/${MATCHES} victoires, part bleue moyenne ${(redWinRate[diff].share * 100).toFixed(0)}%`);
}

// L'échelle doit monter : imbattable doit écraser le bot, facile doit le laisser vivre.
if (redWinRate.insane.wins < MATCHES) {
  console.log("ATTENTION: l'IA imbattable ne gagne pas tous ses matchs contre le bot moyen");
}
if (redWinRate.easy.wins > MATCHES / 2) {
  console.log("ATTENTION: l'IA facile bat le bot moyen plus d'une fois sur deux");
}

await browser.close();
server.close();
console.log(failed ? "ERREURS ci-dessus" : "Bench terminé sans erreur de page ✓");
process.exit(failed ? 1 : 0);
