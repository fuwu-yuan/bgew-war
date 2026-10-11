# BGEW WAR — Cloud Functions (ranked validation)

`submitMatchResult` is an authenticated **callable** function. Each player sends
their own match report; the function pairs the two reports for one match id and
records the result only when they agree and pass the anti-cheat checks
(see `index.js`). Stats are written by this function alone — the Firestore rules
forbid clients from touching `wins/losses/games/bestTime`.

## Prerequisites
- The Firebase project must be on the **Blaze (pay-as-you-go)** plan. Cloud
  Functions cannot be deployed on the free Spark plan. (Idle cost is ~0; you pay
  per invocation, which for this game is negligible.)
- Firebase CLI: `npm i -g firebase-tools` then `firebase login`.

## Deploy
From the repo root (project is `bgew-war`, see `.firebaserc`):

```bash
cd functions && npm install && cd ..
firebase deploy --only functions,firestore:rules
```

The callable runs in the default region **us-central1** — the web client uses
`getFunctions(app)` with the same default, so they match. If you change the
region, set it in both places.

## Local check (optional)
```bash
node --check functions/index.js          # syntax
firebase emulators:start --only functions,firestore   # full local run
```

## Data model
- `users/{uid}` — profile + stats (function-written).
- `users/{uid}/matches/{id}` — per-player history (function-written, owner-readable).
- `matches/{matchId}` — the single-use validation doc ("match token"):
  `status: open|resolved|disputed`, the two `reports`, and `reasons` when disputed.

---

# Niveau CLAUDE — `claudeTurn`

Le dernier niveau solo (**CLAUDE (PRIVE)** dans le menu) fait jouer le général
rouge par un vrai modèle Claude (Anthropic). Le client envoie, toutes les
quelques secondes, l'état du jeu **tel que le joueur le voit** (carte ASCII,
bâtiments, unités par colonne, niveaux, ordres visibles) plus un court journal
des décisions précédentes ; le modèle répond un plan structuré (axe, réserve
d'or, 0 à 4 ordres, une réplique) que le **lieutenant local** (`game.step.ts`)
exécute avec exactement les règles et l'or d'un joueur humain. Fair-play
inchangé : aucun or, aucune information, aucune unité en plus.

Le niveau est **protégé par mot de passe** pour le moment : le mot de passe
borne la facture API et la clé Anthropic ne quitte jamais la fonction.

## Mise en place (une fois)

```bash
cd functions && npm install && cd ..
firebase login --reauth                                  # si besoin
firebase functions:secrets:set ANTHROPIC_API_KEY         # clé console.anthropic.com
firebase functions:secrets:set CLAUDE_LEVEL_PASSWORD     # le mot de passe du niveau
firebase deploy --only functions
```

Réglages non secrets dans `functions/.env` : `CLAUDE_MODEL` (défaut
`claude-opus-5-5`), `CLAUDE_EFFORT` (`low` | `medium` | `high` : profondeur de
réflexion par tour, donc latence), `CLAUDE_DAILY_CALLS` (coupe-circuit : appels
par jour, tous joueurs confondus ; au-delà la fonction répond
`resource-exhausted` et le lieutenant joue seul).

## Protocole

- `{ password, ping: true }` → `{ ok: true }` : vérification du mot de passe
  depuis le menu, sans appel au modèle.
- `{ password, state, journal }` → `{ plan, latencyMs, model, usage }`.
- Erreurs : `permission-denied` (mot de passe), `resource-exhausted` (quota du
  jour), `unavailable` (modèle injoignable / refus). Côté client, après 14 s
  sans plan, l'IA **IMBATTABLE** locale prend le relais pour que la partie ne
  se fige jamais ; le général reprend la main dès qu'il répond.

## Coût et suivi

`claudeUsage/{AAAA-MM-JJ}` (Firestore, écrit par la fonction) cumule appels,
tokens et latence. Ordre de grandeur avec Opus 5.5 : ~0,5 ct par tour, soit
~0,40 € pour un match de 5 min (un tour toutes les 3-5 s).

## Test local

```bash
node tools/claude-function-test.mjs          # prompt + schéma + épuration, sans réseau
ANTHROPIC_API_KEY=sk-ant-... node tools/claude-function-test.mjs --live   # un vrai tour, latence low/medium
```
