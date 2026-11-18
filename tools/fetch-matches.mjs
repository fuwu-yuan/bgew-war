/**
 * Télécharge l'historique des parties solo (collection Firestore `soloMatches`)
 * dans training/matches/<id>.json, au format SoloRecord rejouable
 * (`node tools/replay-check.mjs --file training/matches/<id>.json`).
 * Identifiants : ceux de gcloud (`gcloud auth application-default login`).
 * Usage : node tools/fetch-matches.mjs [--limit 500]
 */
import { createRequire } from "module";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "functions/index.js"));
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const li = process.argv.indexOf("--limit");
const LIMIT = li >= 0 ? Number(process.argv[li + 1]) : 500;
initializeApp({ credential: applicationDefault(), projectId: "bgew-war" });
const db = getFirestore();
const dir = join(ROOT, "training/matches");
mkdirSync(dir, { recursive: true });

const snap = await db.collection("soloMatches").orderBy("createdAt", "desc").limit(LIMIT).get();
let fresh = 0;
const rows = [];
for (const doc of snap.docs) {
  const x = doc.data();
  const rec = { id: doc.id, version: x.version, difficulty: x.difficulty, seed: x.seed, map: JSON.parse(x.map), cmds: JSON.parse(x.cmds), bal: x.bal, ticks: x.ticks, time: x.time, win: x.win, share: x.share, uid: x.uid || "", createdAt: x.createdAt ? x.createdAt.toDate().toISOString() : null };
  const file = join(dir, `${doc.id}.json`);
  if (!existsSync(file)) { writeFileSync(file, JSON.stringify(rec)); fresh++; }
  rows.push(rec);
}
console.log(`${snap.size} partie(s) dans l'historique, ${fresh} nouvelle(s) → training/matches/`);
const by = {};
for (const r of rows) { const k = r.difficulty; by[k] = by[k] || { n: 0, w: 0 }; by[k].n++; if (r.win) by[k].w++; }
for (const k of Object.keys(by)) console.log(`  ${k.padEnd(8)} ${by[k].n} parties, ${by[k].w} gagnées par le joueur`);
