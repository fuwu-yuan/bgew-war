/**
 * Test Node du module pur du général Claude (functions/claude-general.js) :
 * prompt construit depuis un rapport réaliste, schéma de sortie, épuration du
 * conseil reçu. Sans réseau : un faux client Anthropic rend un JSON canné.
 *
 * Avec ANTHROPIC_API_KEY dans l'environnement (ou `--live`), fait en plus UN
 * vrai appel au modèle sur le rapport d'exemple et affiche le conseil + la latence.
 *
 * Usage : node tools/claude-function-test.mjs [--live]
 */
import { createRequire } from "module";
import assert from "assert/strict";

const require = createRequire(import.meta.url);
const { buildPrompt, sanitizeAdvice, askGeneral, DOCTRINE_SCHEMA, SPEND, GENES } = require("../functions/claude-general.js");

/* ---- un rapport plausible à 95 s de jeu ------------------------------- */
const ups = (s, t) => ({ soldier: { atk: s, def: s }, tank: { atk: t, def: 1 }, turret: { atk: 1, def: 1 }, heli: { atk: 1, def: 1 } });
const doctrine = {
  w: { barracks: 2, factory: 1.5, turret: 1, strike: 1, heli: 0.7, soldierAtk: 1.2, soldierDef: 0.8, tankAtk: 0.5, tankDef: 0.5, turretAtk: 0.3, turretDef: 0.2, heliAtk: 0.2, heliDef: 0.2 },
  bank: 40, strikeMin: 8, turretShare: 0.47, heliMaxAA: 1, backMin: 2, backSpan: 3, spread: 3, axAdvance: 1.2, axEnemy: 0.6,
  axisHold: 3, defendRadius: 240, ecoUntil: 60, ecoBoost: 1.5, vsTanks: 1.5, vsMass: 1.5, vsAir: 2, maxBarracks: 10, maxFactories: 4, maxTurrets: 8,
};
const report = {
  turn: 4,
  t: 95,
  share: 0.44,
  trend: [0.5, 0.49, 0.47, 0.46, 0.44],
  gold: 133,
  suddenDeathIn: 265,
  hq: { red: 1, blue: 1 },
  me: { barracks: 5, factories: 1, turrets: 2, frontTurrets: 0, soldiers: 88, tanks: 6, helis: 0, ups: ups(2, 1) },
  foe: { barracks: 7, factories: 0, turrets: 2, frontTurrets: 0, soldiers: 141, tanks: 0, helis: 0, ups: ups(3, 1) },
  habits: { strikes: 0, helis: 0, barracks: 4, forwardBarracks: 3, factories: 0, turrets: 0, upgrades: { soldierAtk: 2, soldierDef: 2 }, favoredCol: 3, recent: ["t=71 barracks (2,12)", "t=80 amelioration soldierDef", "t=88 barracks (13,12)"] },
  spent: { barracks: 118, factory: 120, soldierAtk: 60, soldierDef: 60 },
  doctrine,
};
const journal = [{ t: 52, analyse: "Il masse des soldats et monte leurs niveaux.", changes: "soldierAtk 1.2→2.5", shareBefore: 0.49, shareAfter: 0.46 }];

/* ---- prompt -------------------------------------------------------------- */
const prompt = buildPrompt(report, journal);
assert.match(prompt, /Rapport 4 — 95 s/);
assert.match(prompt, /mort subite dans 265 s/);
assert.match(prompt, /rouge 44% \/ bleu 56%/);
assert.match(prompt, /4 casernes \(dont 3 à moins de 2 rangées de son front\)/);
assert.match(prompt, /soldierDef ×2/);
assert.match(prompt, /soldats 3\/3/); // niveaux force/défense du joueur
assert.match(prompt, /strikeMin : 3 à 30/); // bornes rappelées au modèle
assert.match(prompt, /soldierAtk 1.2→2.5/); // journal
assert.ok(!/or du joueur|blueGold/.test(prompt), "le prompt ne doit rien dire de l'or du joueur");
assert.match(buildPrompt({ ...report, suddenDeathIn: -5 }, []), /MORT SUBITE EN COURS/);
assert.match(buildPrompt({}, null), /Premier rapport/); // rapport vide : ne plante pas
console.log(`[buildPrompt] OK — ${prompt.length} caractères`);

/* ---- schéma : strict, tous les champs requis -------------------------------- */
const dp = DOCTRINE_SCHEMA.properties.doctrine;
assert.equal(DOCTRINE_SCHEMA.additionalProperties, false);
assert.deepEqual(dp.properties.w.required, SPEND);
for (const k of Object.keys(GENES)) assert.ok(dp.required.includes(k), `gène ${k} absent du schéma`);
console.log("[schema] OK");

/* ---- épuration : bornes, champs illisibles → null (= inchangé côté client) -- */
const clean = sanitizeAdvice({
  analyse: "x".repeat(900),
  message: "  Vos   casernes   avancées\nvont brûler.  ",
  doctrine: { w: { strike: 99, heli: -3, barracks: "abc" }, bank: 5000, strikeMin: "5", heliMaxAA: null, intrus: 12 },
});
assert.equal(clean.analyse.length, 400);
assert.equal(clean.message, "Vos casernes avancées vont brûler.");
assert.equal(clean.doctrine.w.strike, 6);
assert.equal(clean.doctrine.w.heli, 0);
assert.equal(clean.doctrine.w.barracks, null);
assert.equal(clean.doctrine.bank, 200);
assert.equal(clean.doctrine.strikeMin, 5);
assert.equal(clean.doctrine.heliMaxAA, null); // absent = inchangé, pas 0
assert.ok(!("intrus" in clean.doctrine));
assert.equal(sanitizeAdvice(null).message, "");
console.log("[sanitizeAdvice] OK");

/* ---- askGeneral avec un faux client ------------------------------------- */
const canned = {
  analyse: "Masse de soldats niveau 3 avec casernes avancées : je frappe ses chantiers et je suis ses niveaux.",
  message: "Vos casernes avancées vont brûler.",
  doctrine: { ...doctrine, w: { ...doctrine.w, strike: 3, soldierAtk: 2.5 }, strikeMin: 5 },
};
let captured = null;
const fake = {
  messages: {
    create: async (params) => {
      captured = params;
      return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(canned) }], usage: { input_tokens: 2400, output_tokens: 260 } };
    },
  },
};
const out = await askGeneral(fake, { report, journal, model: "claude-opus-5-5", effort: "low" });
assert.equal(captured.model, "claude-opus-5-5");
assert.equal(captured.output_config.effort, "low");
assert.equal(captured.output_config.format.type, "json_schema");
assert.equal(captured.output_config.format.schema, DOCTRINE_SCHEMA);
assert.equal(captured.system[0].cache_control.type, "ephemeral");
assert.equal(out.advice.doctrine.w.strike, 3);
assert.equal(out.advice.doctrine.strikeMin, 5);
console.log("[askGeneral/fake] OK —", out.advice.message);

const refusing = { messages: { create: async () => ({ stop_reason: "refusal", stop_details: { explanation: "test" }, content: [] }) } };
await assert.rejects(() => askGeneral(refusing, { report, journal }), /refusal/);
const garbage = { messages: { create: async () => ({ stop_reason: "max_tokens", content: [{ type: "text", text: "{not json" }] }) } };
await assert.rejects(() => askGeneral(garbage, { report, journal }), /illisible/);
console.log("[askGeneral/erreurs] OK");

/* ---- appel réel (optionnel) ---------------------------------------------- */
if (process.argv.includes("--live") || process.env.ANTHROPIC_API_KEY) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic();
  for (const effort of ["low", "medium"]) {
    const t0 = Date.now();
    const live = await askGeneral(client, { report, journal, model: process.env.CLAUDE_MODEL || "claude-opus-5-5", effort });
    console.log(`\n[live ${effort}] ${Date.now() - t0} ms — usage ${JSON.stringify(live.usage)}`);
    console.log(JSON.stringify(live.raw, null, 2));
  }
} else {
  console.log("\n(pas d'ANTHROPIC_API_KEY : appel réel sauté — `ANTHROPIC_API_KEY=... node tools/claude-function-test.mjs --live`)");
}
console.log("\nclaude-function-test: OK");
