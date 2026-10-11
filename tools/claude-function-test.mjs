/**
 * Test Node du module pur du général Claude (functions/claude-general.js) :
 * prompt construit depuis un état réaliste, schéma de sortie, épuration du
 * plan reçu. Sans réseau : un faux client Anthropic rend un JSON canné.
 *
 * Avec ANTHROPIC_API_KEY dans l'environnement (ou `--live`), fait en plus UN
 * vrai appel au modèle sur l'état d'exemple et affiche le plan + la latence.
 *
 * Usage : node tools/claude-function-test.mjs [--live]
 */
import { createRequire } from "module";
import assert from "assert/strict";

const require = createRequire(import.meta.url);
const { buildPrompt, sanitizePlan, askGeneral, PLAN_SCHEMA, GRID_W, GRID_H } = require("../functions/claude-general.js");

/* ---- un état plausible à 95 s de jeu ---------------------------------- */
const map = [];
for (let r = 0; r < GRID_H; r++) {
  let line = "";
  for (let c = 0; c < GRID_W; c++) {
    const water = (c === 0 && (r < 3 || r > 18)) || (c === 15 && (r < 2 || r > 19));
    line += water ? "~" : r < 11 ? "r" : "b";
  }
  map.push(line);
}
const put = (r, c, ch) => (map[r] = map[r].slice(0, c) + ch + map[r].slice(c + 1));
put(2, 8, "Q");
put(4, 4, "C");
put(4, 8, "C");
put(4, 12, "C");
put(3, 6, "T");
put(3, 10, "T");
put(19, 8, "q");
put(17, 4, "c");
put(17, 8, "c");
put(17, 12, "c");
put(18, 6, "t");
put(18, 10, "t");
put(16, 7, "u");
put(9, 3, "$");

const state = {
  turn: 7,
  t: 95,
  gold: 143,
  share: 0.52,
  axis: 8,
  reserve: 120,
  levels: { red: { soldiers: 2, tanks: 1, turrets: 1 }, blue: { soldiers: 2, tanks: 1, turrets: 2 } },
  upgradeCost: { soldiers: 181, tanks: 120, turrets: 100 },
  units: { red: { soldiers: 31, tanks: 0 }, blue: { soldiers: 36, tanks: 3 } },
  helis: { red: 0, blue: 0 },
  hq: { red: 1, blue: 1 },
  map,
  cols: {
    blueFront: [22, 12, 11, 11, 10, 10, 9, 9, 10, 11, 11, 12, 12, 12, 13, 22],
    red: [0, 1, 2, 3, 2, 4, 5, 3, 2, 2, 1, 2, 1, 1, 0, 0],
    blue: [0, 0, 2, 3, 5, 6, 8, 5, 2, 1, 1, 1, 2, 1, 0, 0],
  },
  redBuildings: [
    { type: "hq", c: 8, r: 2, hp: 1, building: false },
    { type: "barracks", c: 4, r: 4, hp: 1, building: false },
    { type: "barracks", c: 8, r: 4, hp: 0.6, building: false },
    { type: "barracks", c: 12, r: 4, hp: 1, building: false },
    { type: "turret", c: 6, r: 3, hp: 1, building: false },
    { type: "turret", c: 10, r: 3, hp: 1, building: false },
  ],
  blueBuildings: [
    { type: "hq", c: 8, r: 19, hp: 1, building: false },
    { type: "barracks", c: 4, r: 17, hp: 1, building: false },
    { type: "barracks", c: 8, r: 17, hp: 1, building: false },
    { type: "barracks", c: 12, r: 17, hp: 1, building: false },
    { type: "turret", c: 6, r: 18, hp: 1, building: false },
    { type: "turret", c: 10, r: 18, hp: 1, building: false },
    { type: "factory", c: 7, r: 16, hp: 0.5, building: true },
  ],
  habits: { strikes: 2, helis: 0, upSoldier: 1, upTank: 0, upTurret: 1, favoredCol: 6 },
  deepestBlueRow: 9,
  pending: ["usine (5,5)"],
  lieutenant: "",
};
const journal = [
  {
    t: 88,
    axe: 6,
    reserve: 120,
    message: "On tient la gauche.",
    faits: ["caserne (5,6)", "frappe groupe"],
    ignores: ["helico colonne 2 (3 helicos deja en vol)"],
    partAvant: 0.5,
    partApres: 0.52,
    orAvant: 210,
    orApres: 60,
  },
];

/* ---- prompt -------------------------------------------------------------- */
const prompt = buildPrompt(state, journal);
assert.ok(prompt.includes("Tour 7"), "tour");
assert.ok(prompt.includes(" 2   ~rrrrrrrQrrrrrrr"), "carte avec QG rouge");
assert.ok(prompt.includes("Front bleu"), "colonnes");
assert.ok(prompt.includes("usine(7,16) 50% chantier"), "bâtiment bleu en chantier");
assert.ok(prompt.includes("helicos deja en vol"), "journal");
assert.ok(prompt.includes("usine (5,5)"), "ordres en attente");
console.log(prompt);
console.log(`\n[prompt] ${prompt.length} caractères (~${Math.round(prompt.length / 3.2)} tokens)\n`);

/* ---- épuration du plan --------------------------------------------------- */
const dirty = {
  analyse: "x".repeat(900),
  message: "  On   frappe\n le centre !  ",
  axe: 27,
  reserve: -40,
  ordres: [
    { type: "frappe", col: 99, ligne: -5, cible: "colonne", quoi: "tanks" },
    { type: "caserne", col: 5, ligne: 6, cible: "groupe", quoi: "soldats" },
    { type: "amelioration", col: 1, ligne: 1, cible: "aucune", quoi: "aucune" },
    { type: "helico", col: -1, ligne: -1, cible: "aucune", quoi: "aucune" },
    { type: "frappe", col: -1, ligne: -1, cible: "batiment", quoi: "aucune" },
    { type: "bombe", col: 1, ligne: 1 },
    { type: "usine", col: 2, ligne: 2, cible: "aucune", quoi: "aucune" },
  ],
};
const clean = sanitizePlan(dirty);
assert.equal(clean.analyse.length, 400);
assert.equal(clean.message, "On frappe le centre !");
assert.equal(clean.axe, 15);
assert.equal(clean.reserve, 0);
assert.equal(clean.ordres.length, 4, "4 ordres max, amélioration vide et type inconnu écartés");
assert.deepEqual(clean.ordres[0], { type: "frappe", col: 15, ligne: -1, cible: "colonne", quoi: "aucune" });
assert.deepEqual(clean.ordres[1], { type: "caserne", col: 5, ligne: 6, cible: "aucune", quoi: "aucune" });
assert.deepEqual(clean.ordres[2], { type: "helico", col: 8, ligne: -1, cible: "aucune", quoi: "aucune" });
assert.deepEqual(clean.ordres[3], { type: "frappe", col: -1, ligne: -1, cible: "groupe", quoi: "aucune" });
assert.deepEqual(sanitizePlan(null), { analyse: "", message: "", axe: 8, reserve: 100, ordres: [] });
console.log("[sanitizePlan] OK");

/* ---- askGeneral avec un faux client ------------------------------------- */
const canned = {
  analyse: "Le bleu masse à gauche (colonnes 4-7) avec une usine en chantier. Je frappe le paquet, je pousse à droite.",
  message: "Votre usine ne verra pas le jour.",
  axe: 12,
  reserve: 120,
  ordres: [
    { type: "frappe", col: 7, ligne: 16, cible: "batiment", quoi: "aucune" },
    { type: "tourelle", col: 6, ligne: 7, cible: "aucune", quoi: "aucune" },
    { type: "amelioration", col: -1, ligne: -1, cible: "aucune", quoi: "tourelles" },
  ],
};
let captured = null;
const fake = {
  messages: {
    create: async (params) => {
      captured = params;
      return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(canned) }], usage: { input_tokens: 1900, output_tokens: 180 } };
    },
  },
};
const out = await askGeneral(fake, { state, journal, model: "claude-opus-5-5", effort: "medium" });
assert.equal(captured.model, "claude-opus-5-5");
assert.equal(captured.output_config.effort, "medium");
assert.equal(captured.output_config.format.type, "json_schema");
assert.equal(captured.output_config.format.schema, PLAN_SCHEMA);
assert.equal(captured.system[0].cache_control.type, "ephemeral");
assert.equal(out.plan.axe, 12);
assert.equal(out.plan.ordres.length, 3);
assert.equal(out.plan.ordres[2].quoi, "tourelles");
console.log("[askGeneral/fake] OK —", JSON.stringify(out.plan));

const refusing = { messages: { create: async () => ({ stop_reason: "refusal", stop_details: { explanation: "test" }, content: [] }) } };
await assert.rejects(() => askGeneral(refusing, { state, journal }), /refusal/);
const garbage = { messages: { create: async () => ({ stop_reason: "max_tokens", content: [{ type: "text", text: "{not json" }] }) } };
await assert.rejects(() => askGeneral(garbage, { state, journal }), /illisible/);
console.log("[askGeneral/erreurs] OK");

/* ---- appel réel (optionnel) ---------------------------------------------- */
if (process.argv.includes("--live") || process.env.ANTHROPIC_API_KEY) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic();
  for (const effort of ["low", "medium"]) {
    const t0 = Date.now();
    const live = await askGeneral(client, { state, journal, model: process.env.CLAUDE_MODEL || "claude-opus-5-5", effort });
    console.log(`\n[live ${effort}] ${Date.now() - t0} ms — usage ${JSON.stringify(live.usage)}`);
    console.log(JSON.stringify(live.raw, null, 2));
  }
} else {
  console.log("\n(pas d'ANTHROPIC_API_KEY : appel réel sauté — `ANTHROPIC_API_KEY=... node tools/claude-function-test.mjs --live`)");
}
console.log("\nclaude-function-test: OK");
