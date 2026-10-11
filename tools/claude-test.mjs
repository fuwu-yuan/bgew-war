/**
 * Test headless du niveau CLAUDE (client) — sans réseau ni clé API : la
 * Cloud Function `claudeTurn` est interceptée (Playwright route) et jouée par
 * un faux général scripté qui lit l'état reçu et répond des plans plausibles.
 *
 * Vérifie, dans Chromium :
 *   1. le menu : bouton CLAUDE (PRIVE) → invite mot de passe → ping → partie ;
 *   2. la boucle général/lieutenant : tours, journal, ordres exécutés, réplique
 *      affichée, aucun appel concurrent, état envoyé = carte + colonnes ;
 *   3. le mode dégradé : fonction en panne → le lieutenant (IA locale) joue ;
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
 * Faux général : lit l'état (carte, colonnes, bâtiments) et répond un plan
 * crédible — comme le ferait le modèle — avec une latence simulée.
 * ------------------------------------------------------------------ */
const calls = [];
let concurrent = 0;
let maxConcurrent = 0;
function fakeGeneral(state) {
  const cols = state.cols;
  // Axe : colonne terrestre où les bleus sont les plus rares et le front le plus haut.
  let axe = 8;
  let best = -Infinity;
  for (let c = 0; c < 16; c++) {
    if (cols.blueFront[c] >= 22) continue;
    const score = cols.blueFront[c] * 1.2 - cols.blue[c] * 0.6;
    if (score > best) {
      best = score;
      axe = c;
    }
  }
  const front = cols.blueFront[axe];
  const blueTurrets = state.blueBuildings.filter((b) => b.type === "turret").length;
  const ordres = [];
  const turn = state.turn;
  if (turn % 3 === 1) ordres.push({ type: "caserne", col: axe, ligne: Math.max(1, front - 3), cible: "aucune", quoi: "aucune" });
  if (turn % 4 === 2) ordres.push({ type: "tourelle", col: axe, ligne: Math.max(1, front - 4), cible: "aucune", quoi: "aucune" });
  ordres.push({ type: "frappe", col: axe, ligne: -1, cible: turn % 2 ? "groupe" : "colonne", quoi: "aucune" });
  if (turn % 5 === 3) ordres.push({ type: "amelioration", col: -1, ligne: -1, cible: "aucune", quoi: "soldats" });
  if (blueTurrets < 2 && turn % 4 === 0) ordres.push({ type: "helico", col: axe, ligne: -1, cible: "aucune", quoi: "aucune" });
  // Un ordre volontairement impossible : case en zone bleue (doit être ignoré proprement).
  if (turn === 6) ordres.unshift({ type: "usine", col: 8, ligne: 20, cible: "aucune", quoi: "aucune" });
  return {
    analyse: `Tour ${turn} : je pousse colonne ${axe}.`,
    message: turn === 1 ? "Je vois votre jeu. Commençons." : `Colonne ${axe}, en avant.`,
    axe,
    reserve: 100,
    ordres: ordres.slice(0, 4),
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
    const plan = fakeGeneral(body.state);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: { plan, latencyMs: 900, model: "fake" } }),
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
  await page.mouse.click(...at(320, 700));
  await page.mouse.click(...at(587, 992)); // AXE
  await page.waitForTimeout(200);
  await page.mouse.click(...at(140, 480));
  await page.waitForTimeout(4000);
  await page.screenshot({ path: "/tmp/bgew-war-claude-3-say.png" });
  await page.waitForTimeout(22000);
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
  console.log("[claude] tours", c.turn, "échecs", c.failures, "journal", (c.journal || []).length, "say:", JSON.stringify(c.say));
  for (const j of c.journal || []) console.log("   ", `t=${Math.round(j.t)}`, "axe", j.axe, "faits:", j.faits.join(", ") || "-", "| ignorés:", j.ignores.join(", ") || "-");
  if (!g.enemyName.includes("CLAUDE")) errors.push(`GAME: nom adverse inattendu « ${g.enemyName} »`);
  if (!c.turn || c.turn < 5) errors.push(`GAME: trop peu de tours du général (${c.turn})`);
  if (c.failures) errors.push(`GAME: échecs d'appel (${c.failures}) ${c.lastError}`);
  if (!c.online) errors.push("GAME: général considéré hors-ligne");
  if ((c.journal || []).length < 3) errors.push("GAME: journal trop court");
  const faits = (c.journal || []).flatMap((j) => j.faits);
  const ignores = (c.journal || []).flatMap((j) => j.ignores);
  if (!faits.some((f) => f.startsWith("caserne"))) errors.push("GAME: aucune caserne construite par le général");
  if (!faits.some((f) => f.startsWith("frappe"))) errors.push("GAME: aucune frappe exécutée");
  if (!ignores.some((f) => f.startsWith("usine (8,20) (aucune case"))) errors.push(`GAME: l'ordre impossible n'a pas été ignoré (${ignores.join(" | ")})`);
  if (!c.say) errors.push("GAME: aucune réplique reçue");
  if (maxConcurrent > 1) errors.push(`GAME: ${maxConcurrent} appels concurrents`);
  // (pas de seuil sur les bâtiments vivants : le faux général pose ses casernes
  // trop près du front et le joueur-test les détruit — c'est son jeu, pas un bug)
  // L'état envoyé ressemble bien à ce que le modèle attend.
  const st = calls[calls.length - 1]?.state;
  if (!st || st.map.length !== 22 || st.map.some((l) => l.length !== 16)) errors.push("GAME: carte envoyée malformée");
  else {
    if (!st.map[2].includes("Q") || !st.map.some((l) => l.includes("q"))) errors.push("GAME: QG absents de la carte envoyée");
    if (st.cols.blueFront.length !== 16) errors.push("GAME: colonnes malformées");
    if (typeof st.gold !== "number" || "blueGold" in st) errors.push("GAME: état malformé (or)");
    if (!Array.isArray(calls[calls.length - 1].journal)) errors.push("GAME: journal absent de la requête");
  }
  console.log(`[claude] ${calls.length} appels, max concurrents ${maxConcurrent}, dernière carte :\n   ` + st.map.join("\n   "));
  await page.close();
}

/* ------------------------------------------------------------------ *
 * 3 — fonction en panne pendant la partie : le lieutenant prend le relais
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
  await page.screenshot({ path: "/tmp/bgew-war-claude-5-lieutenant.png" });
  const d = await page.evaluate(() => {
    const play = window.__bgewwar.steps.play;
    const c = window.__bgewClaude || {};
    return {
      failures: c.failures,
      online: c.online,
      lastError: c.lastError,
      lieutenantRuns: c.lieutenantRuns,
      elapsed: Math.round(play.elapsed),
      redBuildings: play.buildings.filter((b) => b.faction === 1 && !b.dead).length,
      redLevels: play.levels[1] + play.tankLevels[1] + play.turretLevels[1],
      redGold: Math.round(play.gold[1]),
    };
  });
  console.log("[down] t", d.elapsed, "échecs", d.failures, "online", d.online, "cycles lieutenant", d.lieutenantRuns, "bâtiments rouges", d.redBuildings, "niveaux", d.redLevels, "or", d.redGold, "—", d.lastError);
  if (!d.failures) errors.push("DOWN: aucun échec enregistré alors que la fonction est en panne");
  if (d.online) errors.push("DOWN: le général devrait être hors-ligne");
  // Après 14 s de silence, l'IA locale pense toutes les 3 s.
  if (!d.lieutenantRuns || d.lieutenantRuns < 3) errors.push(`DOWN: le lieutenant n'a pas pris le relais (${d.lieutenantRuns} cycles)`);
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
