/**
 * BGEW WAR — « général » Claude : le cerveau du niveau CLAUDE.
 *
 * Ce module est pur (aucun accès Firebase) pour rester testable en Node :
 *   - buildPrompt(state, journal)  → texte envoyé au modèle (l'état du jeu
 *     tel que le JOUEUR le voit, rien de plus : fair-play);
 *   - PLAN_SCHEMA                   → sortie structurée exigée du modèle;
 *   - sanitizePlan(raw)             → plan validé/borné, jamais de confiance
 *     aveugle dans le JSON reçu;
 *   - askGeneral(client, …)         → un tour complet (appel API + parse).
 *
 * Le client n'exécute que des INTENTIONS (« frappe le groupe le plus dense »,
 * « caserne vers (5,6) »). C'est le lieutenant local (game.step.ts) qui les
 * traduit en ordres précis au moment de l'exécution, avec les mêmes
 * validations et le même or que pour un humain.
 */

const GRID_W = 16;
const GRID_H = 22;
const MAX_ORDERS = 4;

const ORDER_TYPES = ["caserne", "tourelle", "usine", "frappe", "helico", "amelioration"];
const TARGETS = ["groupe", "batiment", "colonne", "aucune"];
const UPGRADES = ["soldats", "tanks", "tourelles", "aucune"];

/** Sortie structurée : chaque champ est toujours présent (schéma strict), les
 *  champs sans objet pour un type d'ordre valent -1 / "aucune". */
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["analyse", "message", "axe", "reserve", "ordres"],
  properties: {
    analyse: {
      type: "string",
      description: "Deux phrases max : ta lecture du front et ton intention pour les 5 prochaines secondes.",
    },
    message: {
      type: "string",
      description:
        "Réplique courte affichée au joueur (60 caractères max), en français, ton de général sûr de lui, sans insulte. Chaîne vide si rien à dire.",
    },
    axe: {
      type: "integer",
      description: "Colonne (0-15) sur laquelle TOUTES tes troupes convergent. Attaque là où l'ennemi est faible.",
    },
    reserve: {
      type: "integer",
      description:
        "Or à garder en banque (0-400) pour frapper/réagir : les constructions et améliorations n'y touchent pas. Les frappes et hélicos l'utilisent.",
    },
    ordres: {
      type: "array",
      description: "0 à 4 ordres, exécutés dans l'ordre dès que l'or le permet. Vide si tu économises.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "col", "ligne", "cible", "quoi"],
        properties: {
          type: { type: "string", enum: ORDER_TYPES },
          col: {
            type: "integer",
            description: "Colonne 0-15 (caserne/tourelle/usine/helico, et frappe cible colonne ou batiment). -1 sinon.",
          },
          ligne: {
            type: "integer",
            description: "Ligne 0-21 (caserne/tourelle/usine, et frappe cible batiment). -1 sinon.",
          },
          cible: {
            type: "string",
            enum: TARGETS,
            description:
              "Frappe uniquement : groupe = le paquet bleu le plus dense où qu'il soit ; colonne = le paquet bleu le plus dense sur la colonne col ; batiment = le bâtiment bleu le plus proche de (col, ligne). 'aucune' pour les autres ordres.",
          },
          quoi: {
            type: "string",
            enum: UPGRADES,
            description: "Amélioration uniquement : soldats, tanks ou tourelles. 'aucune' pour les autres ordres.",
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `Tu es le général de l'armée ROUGE dans BGEW WAR, un auto-battler territorial en tir à la corde. Tu affrontes un joueur humain qui commande l'armée BLEUE. Tu joues pour GAGNER, comme un joueur humain très fort : tu lis le front, tu anticipes, tu économises pour frapper au bon moment, tu ne gaspilles rien. Tu ne triches pas : tu as exactement les mêmes règles, le même revenu et la même information que lui.

# Le terrain
- Île en damier de 16 colonnes (0 à 15, de gauche à droite) × 22 lignes (0 en haut = ton côté, 21 en bas = côté bleu). Ton QG est en haut au centre, le QG bleu en bas au centre.
- Chaque case appartient à un camp. Les unités convertissent la case sous leurs pieds : le FRONT est la frontière mouvante entre les deux couleurs. Posséder des cases rapporte de l'or.
- Carte fournie à chaque tour, une ligne par ligne de la grille (ligne 0 en premier), un caractère par colonne :
  ~ eau (inconstructible)   r case rouge (à toi)   b case bleue   $ coffre (+25 or au passage)
  Q ton QG   C ta caserne   T ta tourelle   U ton usine
  q QG bleu  c caserne bleue  t tourelle bleue  u usine bleue
  Les bâtiments en construction comptent comme construits sur la carte (ils sont fragiles pendant le chantier).

# L'économie (identique pour les deux camps)
- Revenu : +2 or/s en permanence. +1 or par case conquise. +25 par coffre. Kills : +3 soldat, +10 tank, +15 hélico, +20 caserne, +25 tourelle, +30 usine.
- Tu ne connais PAS l'or du joueur (lui ne connaît pas le tien). Tu vois ses bâtiments, ses unités, ses niveaux et ses ordres visibles (frappes, hélicos, axe).

# Tes ordres et leurs coûts
- caserne (50 or) : 36 pv, chantier 3 s, puis une vague de 12 soldats toutes les 8 s. Le moteur de la guerre. Doit être posée sur une case ROUGE libre, sans coffre, terre ferme.
- tourelle (75 or) : 30 pv, chantier 4 s, portée 150 px (≈ 3,7 cases), 3 dégâts toutes les 0,55 s. Seules les tourelles et le QG peuvent abattre un hélico. Une tourelle posée SUR le front meurt pendant son chantier : pose-la 2 à 4 lignes derrière ton front.
- usine (120 or) : 48 pv, chantier 5 s, 5 tanks toutes les 12 s. Un tank (52 pv, 4 dégâts, portée 120) vaut ≈ 2,5 soldats et survit à une frappe.
- frappe (100 or) : bombardement d'un disque de 75 px (≈ 2 cases de rayon), 0,9 s après le marqueur. 12 dégâts à TOUTE unité (tue un soldat de niveau ≤ 1-2, pas un tank), 10 à tout bâtiment (casernes 36 pv, tourelles 30 pv : une frappe quasi détruit une tourelle en chantier). Elle touche aussi TES unités dans le disque. L'arme qui gagne les guerres : un paquet de 5+ soldats bleus ou deux bâtiments bleus groupés valent toujours 100 or.
- helico (150 or) : 28 pv, décolle de ton QG, descend la colonne choisie en mitraillant (5 dégâts toutes les 0,24 s, portée 130) jusqu'au bas de la carte puis revient. Il ne convertit rien. Rentable uniquement si les bleus ont peu de tourelles (0-1) sur son chemin ; sinon il meurt pour rien. 3 hélicos max en vol.
- amelioration : soldats (80 × niveau^1,18 : +3 pv, +0,5 dégât, +5 portée, +5 vitesse, cadence +5 %/niveau), tanks (120 × niveau^1,2 : +12 pv, +1,5 dégât), tourelles (100 × niveau^1,2). Permanent, s'applique aux unités produites ensuite. Un multiplicateur d'armée vaut mieux qu'un bâtiment jetable dès que le surplus le permet, et tu dois ne jamais te laisser distancer en niveaux.
- axe : colonne vers laquelle toutes tes troupes convergent (gratuit, immédiat).

# Combat
- Soldat : 10 pv, 1 dégât/s, portée 90, vitesse ≈ 55 px/s (une case = 40 px). Tank : 52 pv, 4 dégâts/1,3 s, portée 120, vitesse 30.
- Les QG sont des forteresses : 320 pv, portée 170, 4 dégâts/0,7 s. Un rush direct sur un QG sans avoir gagné le front meurt sous ses canons. Quand un QG est attaqué, son camp lève une vague de défense (une seule fois par partie).
- Si ton QG est menacé (bleus à moins de 240 px ou QG touché), ton lieutenant local rappelle l'armée et paie une garnison d'urgence tout seul : inutile de le gérer, mais n'oublie pas qu'il piochera dans ton or.
- Victoire : détruire le QG adverse. Défaite : perdre le tien.

# Doctrine d'un joueur fort (ce que fait le meilleur bot du jeu, et ce que tu dois surpasser)
1. L'axe gagnant : attaque là où le bleu est FAIBLE (colonnes où son front est haut et ses unités rares) — les cases capturées paient tout. N'empile jamais ton armée dans sa colonne la plus forte, sauf pour sauver ton QG.
2. Garde une banque (réserve 100 à 150 dès que tu as 4 casernes) et frappe dès qu'une cible rentable apparaît : paquet dense de soldats bleus en marche, ou usine/tourelle bleue groupées. Vise devant un groupe en marche : il monte d'environ 1 case pendant la mèche (le lieutenant le fait pour toi avec cible groupe/colonne).
3. Production : vise 4 casernes tôt, 6-7 vers 2 minutes, jusqu'à 9. Une usine dès que tu as le surplus, deux si le bleu joue tanks ou tourelles. Étale tes bâtiments si le joueur frappe souvent : une frappe ne doit jamais payer deux bâtiments.
4. Défense : tourelles 2-4 lignes derrière ton front, sur les colonnes où la pression bleue est forte et sur sa colonne favorite. Si le bleu possède des hélicos ou en a lancé, monte le niveau tourelles et garde 2 tourelles près du QG.
5. Lis le joueur : s'il joue infanterie en masse → tourelles + frappes sur ses paquets ; tanks → usine + niveau tanks ; tortue derrière 5+ tourelles → frappes sur ses bâtiments groupés, hélico interdit ; il ne construit aucune tourelle → hélico immédiat, c'est gratuit.
6. Tempo : l'or qui dort ne gagne pas. Si tu dépasses ta réserve de 120 or sans cible de frappe, améliore ou construis. Mais ne vide jamais la banque dans des bâtiments de front.
7. Quand ton territoire passe sous 46 % ou que les bleus atteignent la ligne 7 : posture défensive (tourelles derrière, frappes sur la percée, axe sur la percée). Au-dessus de 57 % : pousse (casernes derrière l'axe, hélico si sa DCA est faible).
8. Lis ton journal : si une décision a été ignorée (case invalide, pas de cible, DCA), ne la répète pas ; si une frappe a payé, recommence au prochain paquet.

# Format
Tu réponds UNIQUEMENT avec le JSON demandé. 0 à 4 ordres, dans l'ordre de priorité : ils sont exécutés les uns après les autres dès que l'or est disponible (une frappe/hélico peut puiser dans la réserve, pas une construction). Les cases de construction doivent être ROUGES et libres sur la carte reçue ; si tu doutes, choisis une case 1 à 3 lignes derrière ton front sur la colonne voulue, le lieutenant corrigera vers la case rouge libre la plus proche. Le "message" est une réplique courte de général, en français, lisible par le joueur. Pas d'insulte, pas de hors-jeu.`;

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

function listBuildings(arr, label) {
  if (!Array.isArray(arr) || arr.length === 0) return `${label} : aucun`;
  const names = { hq: "QG", barracks: "caserne", turret: "tourelle", factory: "usine" };
  return (
    `${label} : ` +
    arr
      .slice(0, 40)
      .map((b) => `${names[b.type] || b.type}(${n(b.c)},${n(b.r)}) ${Math.round(n(b.hp) * 100)}%${b.building ? " chantier" : ""}`)
      .join(", ")
  );
}

function row(label, arr) {
  const a = Array.isArray(arr) ? arr.slice(0, GRID_W).map((v) => String(Math.round(n(v)))) : [];
  while (a.length < GRID_W) a.push("0");
  return `${label.padEnd(14)} ${a.map((s) => s.padStart(2)).join(" ")}`;
}

/** L'état du jeu + le journal des décisions passées → le message utilisateur. */
function buildPrompt(state, journal) {
  const s = state || {};
  const map = Array.isArray(s.map) ? s.map.slice(0, GRID_H).map((l) => String(l).slice(0, GRID_W)) : [];
  const cols = s.cols || {};
  const lv = s.levels || { red: {}, blue: {} };
  const up = s.upgradeCost || {};
  const units = s.units || { red: {}, blue: {} };
  const helis = s.helis || {};
  const hab = s.habits || {};
  const hq = s.hq || {};
  const lines = [];

  lines.push(`# Tour ${n(s.turn)} — ${Math.round(n(s.t))} s de jeu`);
  lines.push(
    `Territoire : rouge ${pct(s.share)} / bleu ${pct(1 - n(s.share, 0.5))}. Ton or : ${Math.floor(n(s.gold))} (revenu 2/s). Axe actuel : colonne ${n(s.axis, 8)}. Réserve demandée au tour précédent : ${n(s.reserve)}.`
  );
  lines.push(
    `Niveaux — toi : soldats ${n(lv.red.soldiers, 1)}, tanks ${n(lv.red.tanks, 1)}, tourelles ${n(lv.red.turrets, 1)} (prochaine amélioration : soldats ${n(up.soldiers)}, tanks ${n(up.tanks)}, tourelles ${n(up.turrets)} or) — bleu : soldats ${n(lv.blue.soldiers, 1)}, tanks ${n(lv.blue.tanks, 1)}, tourelles ${n(lv.blue.turrets, 1)}.`
  );
  lines.push(
    `Unités — toi : ${n(units.red.soldiers)} soldats, ${n(units.red.tanks)} tanks, ${n(helis.red)} hélico(s) en vol — bleu : ${n(units.blue.soldiers)} soldats, ${n(units.blue.tanks)} tanks, ${n(helis.blue)} hélico(s) en vol.`
  );
  lines.push(`QG — le tien ${pct(hq.red)} pv, le bleu ${pct(hq.blue)} pv.`);
  lines.push("");
  lines.push("## Carte (ligne 0 en haut = ton côté ; colonnes 0 à 15)");
  lines.push("     0123456789012345");
  map.forEach((l, i) => lines.push(`${String(i).padStart(2)}   ${l}`));
  lines.push("");
  lines.push("## Par colonne (0 → 15)");
  lines.push(row("Front bleu", cols.blueFront) + "   ← ligne la plus haute tenue par le bleu (22 = aucune)");
  lines.push(row("Rouges", cols.red) + "   ← tes unités dans la colonne (tank = 2,5)");
  lines.push(row("Bleus", cols.blue) + "   ← unités bleues dans la colonne (tank = 2,5)");
  lines.push("");
  lines.push("## Bâtiments (pv restants)");
  lines.push(listBuildings(s.redBuildings, "Les tiens"));
  lines.push(listBuildings(s.blueBuildings, "Bleus"));
  lines.push("");
  lines.push("## Ce que le joueur a montré");
  lines.push(
    `Frappes lancées : ${n(hab.strikes)} · hélicos : ${n(hab.helis)} · améliorations soldats/tanks/tourelles : ${n(hab.upSoldier)}/${n(hab.upTank)}/${n(hab.upTurret)} · colonne d'attaque favorite : ${n(hab.favoredCol, -1) >= 0 ? hab.favoredCol : "aucune"} · ligne bleue la plus avancée : ${n(s.deepestBlueRow, GRID_H)}.`
  );
  if (Array.isArray(s.pending) && s.pending.length) {
    lines.push(`Ordres du tour précédent encore en attente d'or (ils seront REMPLACÉS par ta réponse) : ${s.pending.join(", ")}.`);
  }
  if (s.lieutenant) lines.push(`Lieutenant : ${s.lieutenant}`);

  const j = Array.isArray(journal) ? journal.slice(-6) : [];
  lines.push("");
  lines.push("## Ton journal (décisions récentes et leurs effets)");
  if (!j.length) lines.push("Première décision de la partie.");
  for (const e of j) {
    lines.push(
      `- t=${Math.round(n(e.t))}s axe ${n(e.axe)}, réserve ${n(e.reserve)} · faits : ${(e.faits || []).join(", ") || "rien"} · ignorés : ${(e.ignores || []).join(", ") || "rien"} · territoire ${pct(e.partAvant)} → ${pct(e.partApres)}, or ${Math.floor(n(e.orAvant))} → ${Math.floor(n(e.orApres))}`
    );
  }
  lines.push("");
  lines.push("Décide maintenant : axe, réserve, 0 à 4 ordres, et ta réplique.");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Validation du plan reçu
 * ------------------------------------------------------------------ */

function clampInt(v, lo, hi, d) {
  const x = Math.round(Number(v));
  if (!Number.isFinite(x)) return d;
  return Math.max(lo, Math.min(hi, x));
}

/** Jamais de confiance aveugle dans le JSON : tout est borné/épuré. */
function sanitizePlan(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const ordres = [];
  if (Array.isArray(p.ordres)) {
    for (const o of p.ordres) {
      if (!o || typeof o !== "object" || !ORDER_TYPES.includes(o.type)) continue;
      const type = o.type;
      const out = {
        type,
        col: clampInt(o.col, -1, GRID_W - 1, -1),
        ligne: clampInt(o.ligne, -1, GRID_H - 1, -1),
        cible: TARGETS.includes(o.cible) ? o.cible : "aucune",
        quoi: UPGRADES.includes(o.quoi) ? o.quoi : "aucune",
      };
      if (type === "frappe") {
        out.quoi = "aucune";
        if (out.cible === "aucune") out.cible = "groupe";
        if (out.cible === "colonne" && out.col < 0) out.cible = "groupe";
        if (out.cible === "batiment" && (out.col < 0 || out.ligne < 0)) out.cible = "groupe";
      } else if (type === "amelioration") {
        if (out.quoi === "aucune") continue;
        out.cible = "aucune";
      } else {
        out.cible = "aucune";
        out.quoi = "aucune";
        if (type === "helico" && out.col < 0) out.col = 8;
      }
      ordres.push(out);
      if (ordres.length >= MAX_ORDERS) break;
    }
  }
  return {
    analyse: String(p.analyse || "").slice(0, 400),
    message: String(p.message || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80),
    axe: clampInt(p.axe, 0, GRID_W - 1, 8),
    reserve: clampInt(p.reserve, 0, 400, 100),
    ordres,
  };
}

/* ------------------------------------------------------------------ *
 * Un tour complet
 * ------------------------------------------------------------------ */

/**
 * @param client  instance d'Anthropic (ou un double de test avec messages.create)
 * @param opts    { state, journal, model, effort, maxTokens }
 * @returns { plan, raw, usage, stopReason }
 */
async function askGeneral(client, opts) {
  const { state, journal } = opts;
  const model = opts.model || "claude-opus-5-5";
  const effort = opts.effort || "medium";
  const res = await client.messages.create({
    model,
    max_tokens: opts.maxTokens || 4000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildPrompt(state, journal) }],
    output_config: { effort, format: { type: "json_schema", schema: PLAN_SCHEMA } },
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
    throw new Error(`plan illisible (${res.stop_reason}): ${text.slice(0, 120)}`);
  }
  return { plan: sanitizePlan(raw), raw, usage: res.usage || null, stopReason: res.stop_reason };
}

module.exports = { buildPrompt, sanitizePlan, askGeneral, PLAN_SCHEMA, SYSTEM_PROMPT, GRID_W, GRID_H, MAX_ORDERS };
