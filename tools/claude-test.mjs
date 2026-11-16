/**
 * Test headless du niveau CLAUDE (client) — sans réseau ni clé API : la
 * Cloud Function `claudeTurn` est interceptée (Playwright route) et jouée par
 * un faux général scripté qui lit le rapport reçu et répond une doctrine.
 *
 * Vérifie, dans Chromium :
 *   1. le menu : bouton CLAUDE (PRIVE) → invite mot de passe → ping → partie ;
 *   2. la boucle stratège/commandant : rapports envoyés, doctrine appliquée et
 *      bornée, journal, réplique affichée, aucun appel concurrent, et le
 *      commandant local qui joue sans attendre le général ;
 *   3. le mode dégradé : fonction en panne → le commandant joue quand même ;
 *   4. le refus : mauvais mot de passe → message, pas de partie.
 * Captures dans /tmp/bgew-war-claude-*.png. Échec sur toute erreur console.
 *
 * Usage : node tools/claude-test.mjs [path-to-chromium]
 */
import http from "http";
import { readFile } from "fs/promises";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8767;
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
const PASSWORD = "sesame-test";

/* ------------------------------------------------------------------ *
 * Faux général : lit le rapport et répond une doctrine — comme le ferait le
 * modèle — avec une latence simulée. Il glisse exprès une valeur hors bornes
 * (maxTurrets 99) et un champ illisible (heliMaxAA null) : le client doit
 * borner la première et laisser le second inchangé.
 * ------------------------------------------------------------------ */
const calls = [];
let concurrent = 0;
let maxConcurrent = 0;
function fakeGeneral(report) {
  const d = JSON.parse(JSON.stringify(report.doctrine));
  d.w.strike = 5.5;
  d.bank = 77;
  d.maxTurrets = 99;
  d.heliMaxAA = null;
  return {
    analyse: `Rapport ${report.turn} : le joueur a posé ${report.habits.barracks} caserne(s), je frappe plus.`,
    message: report.turn === 1 ? "Je vois votre jeu. Commençons." : "Mes frappes vous attendent.",
    doctrine: d,
  };
}

/** Intercepte le callable Firebase ; `mode` = ok | down | badpass. */
async function routeFunction(page, mode) {
  await page.route("**/claudeTurn", async (route) => {
    const req = route.request();
    let body = {};
    try {
      body = JSON.parse(req.postData() || "{}").data || {};
    } catch {
      /* ignore */
    }
    if (mode === "badpass" || body.password !== PASSWORD) {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "Mot de passe incorrect." } }),
      });
      return;
    }
    if (body.ping) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { ok: true } }) });
      return;
    }
    if (mode === "down") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { status: "UNAVAILABLE", message: "panne simulee" } }),
      });
      return;
    }
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    calls.push(body);
    await new Promise((r) => setTimeout(r, 900)); // latence modèle simulée
    concurrent--;
    const advice = fakeGeneral(body.report);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: { advice, latencyMs: 900, model: "fake" } }),
    });
  });
}

function hook(page, tag, expectHttpErrors = false) {
  page.on("pageerror", (e) => errors.push(`${tag} PAGEERROR: ${e.message}`));
  page.on("console", (m) => {
    // Les scénarios panne/refus provoquent volontairement des 503/403 : le
    // navigateur les journalise ("Failed to load resource"), ce n'est pas un bug.
    if (expectHttpErrors && /Failed to load resource/.test(m.text())) return;
    if (m.type() === "error") errors.push(`${tag} CONSOLE: ${m.text()}`);
  });
}

/* ------------------------------------------------------------------ *
 * 1 + 2 — menu → mot de passe → partie contre le faux général
 * ------------------------------------------------------------------ */
{
  const page = await browser.newPage({ viewport: { width: 760, height: 1100 } });
  hook(page, "GAME");
  await routeFunction(page, "ok");
  page.on("dialog", (d) => d.accept(PASSWORD));
  await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off&debug=1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const canvas = await page.locator("#game canvas").boundingBox();
  if (!canvas) throw new Error("canvas not found");
  const scale = canvas.width / 640;
  const at = (x, y) => [canvas.x + x * scale, canvas.y + y * scale];

  await page.mouse.click(...at(320, 533)); // JOUER
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/bgew-war-claude-1-levels.png" });
  await page.mouse.click(...at(320, 795)); // CLAUDE (PRIVE) → prompt natif
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/tmp/bgew-war-claude-2-start.png" });

  const started = await page.evaluate(() => window.__bgewwar?.board?.step?.name);
  if (started !== "game") errors.push(`GAME: la partie n'a pas démarré après le mot de passe (step=${started})`);
  const pass = await page.evaluate(() => localStorage.getItem("bgew-war.claude-pass"));
  if (pass !== PASSWORD) errors.push("GAME: mot de passe non mémorisé");

  // Le joueur joue un peu (caserne + axe), le général enchaîne ses tours.
  await page.waitForTimeout(3000);
  await page.mouse.click(...at(157, 992)); // CASERNE
  await page.waitForTimeout(200);
  await page.mouse.click(...at(240, 700)); // case bleue libre (6,17)
  await page.mouse.click(...at(587, 992)); // AXE
  await page.waitForTimeout(200);
  await page.mouse.click(...at(140, 480));
  await page.waitForTimeout(4000);
  await page.screenshot({ path: "/tmp/bgew-war-claude-3-say.png" });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: "/tmp/bgew-war-claude-3b-first-advice.png" });
  await page.waitForTimeout(24000); // 2e rapport (≈ 31 s) + sa réponse
  await page.screenshot({ path: "/tmp/bgew-war-claude-4-midgame.png" });

  const g = await page.evaluate(() => {
    const play = window.__bgewwar.steps.play;
    return {
      claude: window.__bgewClaude,
      enemyName: play.enemyName,
      redAxis: play.axisCol[1],
      redBuildings: play.buildings.filter((b) => b.faction === 1 && !b.dead).length,
      ended: play.ended,
    };
  });
  const c = g.claude || {};
  console.log("[claude] rapports", c.turn, "conseils", c.applied, "échecs", c.failures, "journal", (c.journal || []).length, "say:", JSON.stringify(c.say));
  console.log("   changements du dernier conseil :", c.lastChanges);
  for (const j of c.journal || []) console.log("   ", `t=${Math.round(j.t)}`, j.changes, `| territoire ${Math.round(j.shareBefore * 100)} → ${Math.round(j.shareAfter * 100)} %`);
  if (!g.enemyName.includes("CLAUDE")) errors.push(`GAME: nom adverse inattendu « ${g.enemyName} »`);
  if (!c.turn || c.turn < 2) errors.push(`GAME: trop peu de rapports au général (${c.turn})`);
  if (c.failures) errors.push(`GAME: échecs d'appel (${c.failures}) ${c.lastError}`);
  if (!c.applied || c.applied < 2) errors.push(`GAME: conseils non appliqués (${c.applied})`);
  if ((c.journal || []).length < 1) errors.push("GAME: journal vide");
  if (!c.say) errors.push("GAME: aucune réplique reçue");
  if (maxConcurrent > 1) errors.push(`GAME: ${maxConcurrent} appels concurrents`);
  // La doctrine reçue est appliquée, bornée, et les champs illisibles sont ignorés.
  const d = c.doctrine || { w: {} };
  if (d.w.strike !== 5.5 || d.bank !== 77) errors.push(`GAME: doctrine non appliquée (strike ${d.w.strike}, bank ${d.bank})`);
  if (d.maxTurrets !== 12) errors.push(`GAME: valeur hors bornes non ramenée (maxTurrets ${d.maxTurrets})`);
  if (typeof d.heliMaxAA !== "number") errors.push("GAME: un champ illisible a écrasé la doctrine (heliMaxAA)");
  // Le commandant local joue sans attendre le général.
  const spent = Object.values(c.spent || {}).reduce((a, b) => a + b, 0);
  if (!(spent > 0)) errors.push("GAME: le commandant local n'a rien dépensé");
  // Le rapport envoyé ressemble bien à ce que le modèle attend.
  const last = calls[calls.length - 1];
  const rp = last?.report;
  if (!rp) errors.push("GAME: aucun rapport reçu par la fonction");
  else {
    if (typeof rp.gold !== "number" || "blueGold" in rp || "gold" in (rp.foe || {})) errors.push("GAME: rapport malformé (or)");
    if (!rp.foe || rp.foe.barracks < 3 || !rp.me || !rp.me.ups) errors.push("GAME: rapport malformé (camps)");
    if (!rp.doctrine || typeof rp.doctrine.w?.barracks !== "number") errors.push("GAME: doctrine absente du rapport");
    if (!rp.habits || rp.habits.barracks < 1 || !rp.habits.recent.length) errors.push(`GAME: l'ordre du joueur n'a pas été observé (${JSON.stringify(rp.habits)})`);
    if (!Array.isArray(last.journal)) errors.push("GAME: journal absent de la requête");
  }
  console.log(`[claude] ${calls.length} appels, max concurrents ${maxConcurrent}`);
  await page.close();
}

/* ------------------------------------------------------------------ *
 * 3 — fonction en panne pendant la partie : le commandant joue quand même
 * ------------------------------------------------------------------ */
{
  const page = await browser.newPage({ viewport: { width: 760, height: 1100 } });
  hook(page, "DOWN", true);
  await page.addInitScript((p) => localStorage.setItem("bgew-war.claude-pass", p), PASSWORD);
  await routeFunction(page, "down");
  // Le ping aussi tombe en panne ici : on entre par ?diff=claude via un niveau
  // non verrouillé du menu ? Non : onEnter lit ?diff= seulement sans choix du
  // menu, donc on force la transition directement.
  await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off&diff=claude&debug=1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__bgewwar.board.moveToStep("game", {}));
  await page.waitForTimeout(34000);
  await page.screenshot({ path: "/tmp/bgew-war-claude-5-down.png" });
  const d = await page.evaluate(() => {
    const play = window.__bgewwar.steps.play;
    const c = window.__bgewClaude || {};
    return {
      turn: c.turn,
      failures: c.failures,
      applied: c.applied,
      lastError: c.lastError,
      spent: Object.values(c.spent || {}).reduce((a, b) => a + b, 0),
      elapsed: Math.round(play.elapsed),
      redBuildings: play.buildings.filter((b) => b.faction === 1 && !b.dead).length,
      redGold: Math.round(play.gold[1]),
    };
  });
  console.log("[down] t", d.elapsed, "rapports", d.turn, "échecs", d.failures, "or dépensé par le commandant", d.spent, "bâtiments rouges", d.redBuildings, "or", d.redGold, "—", d.lastError);
  if (!d.failures) errors.push("DOWN: aucun échec enregistré alors que la fonction est en panne");
  if (d.applied) errors.push("DOWN: un conseil a été appliqué alors que la fonction est en panne");
  // Le général est muet, mais le commandant local joue : il doit avoir dépensé son or.
  if (!(d.spent > 100)) errors.push(`DOWN: le commandant n'a pas joué sans le général (or dépensé ${d.spent})`);
  await page.close();
}

/* ------------------------------------------------------------------ *
 * 4 — mauvais mot de passe : message au menu, pas de partie
 * ------------------------------------------------------------------ */
{
  const page = await browser.newPage({ viewport: { width: 760, height: 1100 } });
  hook(page, "BADPASS", true);
  await routeFunction(page, "badpass");
  page.on("dialog", (d) => d.accept("mauvais"));
  await page.goto(`http://localhost:${PORT}/?firebase=off&splash=off`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const canvas = await page.locator("#game canvas").boundingBox();
  const scale = canvas.width / 640;
  const at = (x, y) => [canvas.x + x * scale, canvas.y + y * scale];
  await page.mouse.click(...at(320, 533)); // JOUER
  await page.waitForTimeout(500);
  await page.mouse.click(...at(320, 795)); // CLAUDE
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/tmp/bgew-war-claude-6-badpass.png" });
  const r = await page.evaluate(() => ({
    step: window.__bgewwar.board.step.name,
    pass: localStorage.getItem("bgew-war.claude-pass"),
  }));
  if (r.step !== "menu") errors.push(`BADPASS: la partie a démarré (step=${r.step})`);
  if (r.pass) errors.push("BADPASS: mot de passe incorrect mémorisé");
  // Retour possible après l'échec
  await page.mouse.click(...at(320, 858)); // RETOUR
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => window.__bgewwar.steps.menu?.diffOpen);
  if (back) errors.push("BADPASS: RETOUR inopérant après l'échec");
  await page.close();
}

await browser.close();
server.close();

if (errors.length) {
  console.error("\nclaude-test: ÉCHEC\n" + errors.map((e) => " - " + e).join("\n"));
  process.exit(1);
}
console.log("\nclaude-test: OK — captures /tmp/bgew-war-claude-*.png");
