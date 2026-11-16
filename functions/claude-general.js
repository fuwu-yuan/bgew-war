/**
 * BGEW WAR — général Claude : le STRATÈGE du niveau CLAUDE.
 *
 * Depuis la v1.12, Claude ne joue plus les coups (un modèle distant est trop
 * lent pour un jeu en temps réel). C'est le commandant local (src/commander.ts,
 * entraîné par auto-jeu) qui joue en continu, sans jamais attendre. Claude, lui,
 * observe la partie toutes les ~20 s — surtout CE QUE FAIT LE JOUEUR — et
 * renvoie une DOCTRINE : les réglages du commandant (poids de dépense, seuils,
 * réactions). Le commandant l'applique aussitôt.
 *
 * Ce module est pur (aucun accès Firebase) pour rester testable en Node :
 *   - buildPrompt(report, journal)  → texte envoyé au modèle ;
 *   - DOCTRINE_SCHEMA                → sortie structurée exigée ;
 *   - sanitizeAdvice(raw)            → conseil validé/borné (jamais de confiance
 *     aveugle dans le JSON reçu ; le client re-borne de toute façon) ;
 *   - askGeneral(client, …)          → un tour complet (appel API + parse).
 */

const SPEND = ["barracks", "factory", "turret", "strike", "heli", "soldierAtk", "soldierDef", "tankAtk", "tankDef", "turretAtk", "turretDef", "heliAtk", "heliDef"];

/** Gènes que Claude peut régler : [min, max, description]. */
const GENES = {
  bank: [0, 200, "Or gardé en banque : les constructions et améliorations n'y touchent pas (frappes et hélicos, si)."],
  strikeMin: [3, 30, "Valeur minimale détruite pour lancer une frappe (1 = un soldat, 5 = un tank, 10 = une caserne). Bas = frappe souvent."],
  turretShare: [0.2, 1, "Tourelles seulement si ta part de territoire est SOUS ce seuil (ou si un hélico ennemi vole). 1 = en construire tout le temps."],
  heliMaxAA: [0, 6, "Hélico seulement si le joueur a au plus ce nombre de tourelles sur la colonne visée. 0 = jamais face à une tourelle."],
  backMin: [0, 5, "Rangées minimum derrière ton front où poser un bâtiment. 0 = sur le front (le chantier meurt souvent), 2-3 = sûr."],
  backSpan: [0, 5, "Étalement en profondeur des bâtiments (rangées en plus de backMin)."],
  spread: [1, 8, "Demi-largeur (colonnes) autour de l'axe où tu construis. Large = bâtiments étalés (moins vulnérables aux frappes)."],
  axAdvance: [0, 3, "Choix de l'axe : poids de l'avancée de ton front (haut = tu enfonces là où tu perces déjà)."],
  axEnemy: [0, 3, "Choix de l'axe : poids de la présence ennemie (haut = tu évites ses concentrations, tu attaques où il est faible)."],
  vsTanks: [0.5, 4, "Multiplicateur usines + niveaux tanks quand le joueur aligne des tanks."],
  vsMass: [0.5, 4, "Multiplicateur frappes + tourelles quand son infanterie te déborde en nombre."],
  vsAir: [0.5, 4, "Multiplicateur tourelles + niveaux tourelles quand il sort des hélicos."],
  maxBarracks: [4, 14, "Plafond de casernes."],
  maxFactories: [0, 6, "Plafond d'usines."],
  maxTurrets: [2, 12, "Plafond de tourelles."],
};
const WEIGHT_MAX = 6;

const weightProps = {};
for (const k of SPEND) weightProps[k] = { type: "number" };
const geneProps = {};
for (const k of Object.keys(GENES)) geneProps[k] = { type: "number" };

/** Sortie structurée : chaque champ est toujours présent (schéma strict). */
const DOCTRINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["analyse", "message", "doctrine"],
  properties: {
    analyse: {
      type: "string",
      description: "Deux phrases max : ce que fait le joueur, et ce que tu changes pour le contrer.",
    },
    message: {
      type: "string",
      description: "Réplique courte affichée au joueur (60 caractères max), en français, ton de général sûr de lui, sans insulte. Chaîne vide si rien à dire.",
    },
    doctrine: {
      type: "object",
      additionalProperties: false,
      required: ["w", ...Object.keys(GENES)],
      properties: {
        w: {
          type: "object",
          additionalProperties: false,
          required: SPEND,
          properties: weightProps,
          description: "Poids de dépense par catégorie (0 à 6). L'or va à la catégorie la plus en retard sur son poids ; 0 = jamais.",
        },
        ...geneProps,
      },
    },
  },
};

const SYSTEM_PROMPT = `Tu es le général de l'armée ROUGE dans BGEW WAR, un auto-battler territorial en tir à la corde. Tu affrontes un joueur humain qui commande l'armée BLEUE. Tu veux GAGNER.

# Ton rôle : stratège, pas exécutant
Un commandant local joue pour toi en continu (il achète, construit, vise les frappes, choisit l'axe, défend le QG) sans jamais t'attendre. Il obéit à une DOCTRINE : une liste de réglages. Sa doctrine de départ a été entraînée par des milliers de parties d'auto-jeu : elle est déjà très forte contre un adversaire quelconque. Toi, tu vois ce que l'entraînement ne peut pas voir : CE joueur, dans CETTE partie. Toutes les 20 secondes environ, tu reçois un rapport et tu renvoies la doctrine complète à appliquer.
- Ne change la doctrine que pour une RAISON observée (ce que le joueur fait, ce qui marche ou échoue). Sans raison, renvoie-la telle quelle : un changement gratuit affaiblit un réglage entraîné.
- Change franchement quand il y a une raison : un poids ×2 ou mis à 0 a un effet ; +10 % n'en a aucun.
- Tu ne triches pas : mêmes règles, même revenu, même information que le joueur. Tu ne connais pas son or.

# Le jeu
- Île en damier de 16 colonnes × 22 lignes. Ton QG est en haut au centre, le sien en bas. Chaque case appartient à un camp ; les unités convertissent la case sous leurs pieds : le FRONT est la frontière mouvante. Victoire : détruire le QG adverse.
- Or : 120 au départ, +3/s, +1 par case conquise, +25 par coffre. Primes : soldat 0,75, tank 6, hélico 15, caserne 20, tourelle 25, usine 30.
- Prix croissants : chaque caserne au-delà de 3 coûte ×1,35 la précédente (50, 68, 91, 123, 166…), chaque usine ×1,5 (120, 180, 270…), chaque tourelle au-delà de 3 ×1,15 (60, 69…). Le prix retombe quand un bâtiment est détruit.
- L'armée se déploie sur ≈ 6 colonnes de part et d'autre de l'axe d'attaque : un vrai front. Déplacer l'axe concentre les forces d'un côté et dégarnit l'autre.

# Unités, bâtiments, outils
- Caserne (240 pv) : 12 soldats toutes les 8 s. Soldat : 10 pv, 1 dégât/s, portée 90.
- Usine (320 pv) : 4 tanks toutes les 12 s. Tank : 95 pv, 5 dégâts/1,3 s, portée 150, lent. Vaut ≈ 6-8 soldats, survit aux frappes : c'est l'unité de siège, précieuse pour finir une base (tourelles + QG).
- Tourelle (60 or, 480 pv) : portée 150, 4 dégâts toutes les 0,25 s. Arrête l'infanterie ; avec le QG, c'est la SEULE chose qui touche un hélico.
- Frappe (60 or) : disque de 105 px, 16 dégâts à toute unité (tue les soldats jusqu'au niveau 3 de défense inclus, pas un tank), 120 aux bâtiments (tue un chantier). Touche les deux camps.
- Hélico (100 or, 80 pv) : vole vers le front sur une colonne, ralentit pour mitrailler tant qu'il a une cible (7 dégâts toutes les 0,12 s), 22 s d'autonomie, n'entre pas dans la base adverse. Aucune unité au sol ne peut le toucher : dévastateur si le joueur n'a pas de tourelle près du front, gaspillé sinon.
- Améliorations, deux voies par branche, achetées séparément, permanentes pour les unités produites ensuite : FORCE (dégâts, portée, cadence) et DÉFENSE (pv). Soldats : +0,25 dégât ou +3 pv par niveau (60 or × niveau^1,35). Tanks : +1 dégât ou +16 pv (70 × niveau^1,3). Tourelles : +42 % dégâts ou +30 % pv (60 / 50 × niveau^1,2). Hélicos : +25 % dégâts ou +30 % pv (60 × niveau^1,3). La force gagne les combats ; la défense seule ne gagne pas, mais à partir du niveau 4 de défense un soldat (19 pv) survit à une frappe (16).
- QG : 2600 pv, obus à éclats. Chaque camp lève 2 vagues de défense (au premier coup reçu, puis à la moitié des pv de son QG).
- Mort subite à 6:00 : le QG du camp qui tient le MOINS de territoire perd des pv de plus en plus vite. Passé 5 minutes, le territoire décide de tout.

# Lire le joueur (exemples de contres)
- Il frappe beaucoup → étale tes bâtiments (spread haut), monte soldierDef, plus de tanks (insensibles aux frappes).
- Masse de soldats + niveaux → frappes (strike haut, strikeMin bas), tourelles (turretShare haut), suis ses niveaux (soldierAtk/soldierDef).
- Il monte la DÉFENSE de ses soldats (niveau 4+) → tes frappes ne tuent plus : baisse strike, mise sur soldierAtk et les tanks.
- Casernes avancées près du front → frappes sur ses chantiers (strikeMin bas), axe sur ses casernes isolées.
- Il joue tanks → vsTanks haut, hélicos s'il a peu de tourelles (les tanks ne tirent pas en l'air), tankAtk.
- Il sort des hélicos → vsAir haut, turretShare à 1, turretAtk.
- Aucune tourelle bleue près du front → hélicos (heli haut, heliMaxAA 0-1). Beaucoup de tourelles → heli à 0, tanks.
- Il tortue derrière ses tourelles → tanks + tankAtk, frappes inutiles sur les tourelles, garde le territoire pour la mort subite.
- Tu perds du terrain et la mort subite approche → tout sur la masse et la force immédiates (barracks, soldierAtk), pas d'investissement lent.
- Tu domines → finis : tanks pour le siège, pas de nouvelles tourelles (turretShare bas).

# Format
Tu réponds UNIQUEMENT avec le JSON demandé : analyse, message, et la doctrine COMPLÈTE (tous les champs, même inchangés). Les valeurs hors bornes sont ramenées dans les bornes. Le "message" est une réplique courte de général, en français, lisible par le joueur ; pas d'insulte, pas de hors-jeu.`;

/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
function pct(x) {
  return `${Math.round(n(x) * 100)}%`;
}
function r2(x) {
  return Math.round(n(x) * 100) / 100;
}

function sideLine(label, s) {
  const o = s || {};
  const up = o.ups || {};
  const lv = (k) => `${n(up[k] && up[k].atk, 1)}/${n(up[k] && up[k].def, 1)}`;
  return `${label} : ${n(o.barracks)} casernes, ${n(o.factories)} usines, ${n(o.turrets)} tourelles (dont ${n(o.frontTurrets)} près du front) · ${n(o.soldiers)} soldats, ${n(o.tanks)} tanks, ${n(o.helis)} hélico(s) en vol · niveaux force/défense : soldats ${lv("soldier")}, tanks ${lv("tank")}, tourelles ${lv("turret")}, hélicos ${lv("heli")}`;
}

function doctrineText(d) {
  const g = d || {};
  const w = g.w || {};
  const lines = [`poids : ${SPEND.map((k) => `${k} ${r2(w[k])}`).join(", ")}`];
  lines.push(Object.keys(GENES).map((k) => `${k} ${r2(g[k])}`).join(", "));
  return lines.join("\n");
}

/** Le rapport de bataille + le journal des doctrines passées → le message utilisateur. */
function buildPrompt(report, journal) {
  const s = report || {};
  const hab = s.habits || {};
  const hq = s.hq || {};
  const lines = [];
  lines.push(`# Rapport ${n(s.turn)} — ${Math.round(n(s.t))} s de jeu${n(s.suddenDeathIn) > 0 ? ` (mort subite dans ${Math.round(n(s.suddenDeathIn))} s)` : " (MORT SUBITE EN COURS)"}`);
  lines.push(`Territoire : rouge ${pct(s.share)} / bleu ${pct(1 - n(s.share, 0.5))}. Évolution de ta part (toutes les 10 s, du plus ancien au plus récent) : ${(Array.isArray(s.trend) ? s.trend.slice(-8) : []).map(pct).join(" → ") || "—"}.`);
  lines.push(`Ton or : ${Math.floor(n(s.gold))}. QG — le tien ${pct(hq.red)} pv, le bleu ${pct(hq.blue)} pv.`);
  lines.push(sideLine("Toi (rouge)", s.me));
  lines.push(sideLine("Joueur (bleu)", s.foe));
  lines.push("");
  lines.push("## Ce que le joueur a fait depuis le début");
  const up = hab.upgrades || {};
  lines.push(
    `Frappes : ${n(hab.strikes)} · hélicos : ${n(hab.helis)} · bâtiments posés : ${n(hab.barracks)} casernes (dont ${n(hab.forwardBarracks)} à moins de 2 rangées de son front), ${n(hab.factories)} usines, ${n(hab.turrets)} tourelles · améliorations achetées : ${Object.keys(up).length ? Object.keys(up).map((k) => `${k} ×${n(up[k])}`).join(", ") : "aucune"} · axe favori : colonne ${n(hab.favoredCol, -1) >= 0 ? hab.favoredCol : "aucune"}.`
  );
  const recent = Array.isArray(hab.recent) ? hab.recent.slice(-12) : [];
  lines.push(`Ses derniers ordres : ${recent.length ? recent.map((o) => String(o).slice(0, 40)).join(" ; ") : "aucun"}.`);
  lines.push("");
  lines.push("## Ce que ton commandant a dépensé (or par catégorie)");
  const sp = s.spent || {};
  lines.push(SPEND.filter((k) => n(sp[k]) > 0).map((k) => `${k} ${Math.round(n(sp[k]))}`).join(", ") || "rien encore");
  lines.push("");
  lines.push("## Doctrine actuelle du commandant");
  lines.push(doctrineText(s.doctrine));
  lines.push("");
  lines.push("## Bornes des réglages");
  lines.push(`poids w.* : 0 à ${WEIGHT_MAX}`);
  for (const k of Object.keys(GENES)) lines.push(`${k} : ${GENES[k][0]} à ${GENES[k][1]} — ${GENES[k][2]}`);

  const j = Array.isArray(journal) ? journal.slice(-5) : [];
  lines.push("");
  lines.push("## Ton journal (doctrines précédentes et ce qu'elles ont donné)");
  if (!j.length) lines.push("Premier rapport de la partie : la doctrine actuelle est celle de l'entraînement.");
  for (const e of j) {
    lines.push(`- t=${Math.round(n(e.t))}s « ${String(e.analyse || "").slice(0, 200)} » · changements : ${String(e.changes || "aucun").slice(0, 200)} · territoire ${pct(e.shareBefore)} → ${pct(e.shareAfter)}`);
  }
  lines.push("");
  lines.push("Décide maintenant : analyse, réplique, et la doctrine complète.");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Validation du conseil reçu
 * ------------------------------------------------------------------ */

function bound(v, lo, hi, d) {
  if (v === null || v === undefined || v === "") return d; // absent = inchangé (Number(null) vaudrait 0)
  const x = Number(v);
  if (!Number.isFinite(x)) return d;
  return Math.max(lo, Math.min(hi, x));
}

/** Jamais de confiance aveugle dans le JSON : tout est borné ; un champ illisible vaut null (= inchangé côté client). */
function sanitizeAdvice(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const d = p.doctrine && typeof p.doctrine === "object" ? p.doctrine : {};
  const w = {};
  const dw = d.w && typeof d.w === "object" ? d.w : {};
  for (const k of SPEND) w[k] = bound(dw[k], 0, WEIGHT_MAX, null);
  const doctrine = { w };
  for (const k of Object.keys(GENES)) doctrine[k] = bound(d[k], GENES[k][0], GENES[k][1], null);
  return {
    analyse: String(p.analyse || "").slice(0, 400),
    message: String(p.message || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80),
    doctrine,
  };
}

/* ------------------------------------------------------------------ *
 * Un tour complet
 * ------------------------------------------------------------------ */

/**
 * @param client  instance d'Anthropic (ou un double de test avec messages.create)
 * @param opts    { report, journal, model, effort, maxTokens }
 * @returns { advice, raw, usage, stopReason }
 */
async function askGeneral(client, opts) {
  const { report, journal } = opts;
  const model = opts.model || "claude-opus-5-5";
  const effort = opts.effort || "low";
  const res = await client.messages.create({
    model,
    max_tokens: opts.maxTokens || 4000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildPrompt(report, journal) }],
    output_config: { effort, format: { type: "json_schema", schema: DOCTRINE_SCHEMA } },
  });
  if (res.stop_reason === "refusal") {
    const why = res.stop_details && res.stop_details.explanation;
    throw new Error(`refusal${why ? `: ${why}` : ""}`);
  }
  const text = (res.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`conseil illisible (${res.stop_reason}): ${text.slice(0, 120)}`);
  }
  return { advice: sanitizeAdvice(raw), raw, usage: res.usage || null, stopReason: res.stop_reason };
}

module.exports = { buildPrompt, sanitizeAdvice, askGeneral, DOCTRINE_SCHEMA, SYSTEM_PROMPT, SPEND, GENES };
