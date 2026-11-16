# BGEW WAR

Auto-battler territorial en tir à la corde (tug-of-war), reproduction jouable du
*fake gameplay* de la pub « War Inc: Rising » — construit avec
[BGEW](https://github.com/fuwu-yuan/bgew), le Baguette Game Engine Web 🥖.

Deux armées se disputent une île en damier : vos soldats bleus avancent tout
seuls, convertissent les cases sous leurs pieds et le front ondule en
permanence. Vous commandez l'économie : casernes, tourelles, usines à tanks,
et l'axe d'attaque. Détruisez le QG rouge pour gagner.

**Compatible desktop (souris) et mobile (tactile)** : le canvas s'adapte à
l'écran (`board.scale`), les taps sont traduits en événements souris, et tous
les sons sont en WAV/M4A (l'Ogg ne passe pas sur iOS Safari).

## Lancer

```bash
npm install
npm start          # build esbuild + serveur sur http://localhost:5050
```

## Scripts

| Commande | Effet |
| --- | --- |
| `npm run build` | Bundle `src/main.ts` → `dist/bundle.js` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run server` | Serveur multijoueur auto-hébergé (port 8090 par défaut) |
| `npm test` | Build + smoke test headless (Chromium) : desktop + viewport iPhone, captures dans `/tmp/bgew-war-*.png`, échec si la moindre erreur console |
| `npm run test:multi` | Test multijoueur headless : serveur local + 2 pages (hôte/invité), vérifie la synchro et la victoire par forfait |
| `node tools/convert-sounds.mjs` | Reconvertit les `.ogg` téléchargés en WAV/M4A (décodage WebAudio via Chromium headless + `afconvert`) |

## Multijoueur (1 contre 1)

Menu → **MULTIJOUEUR** : l'un crée la partie (il joue les **bleus**), l'autre la
rejoint dans la liste (il joue les **rouges**). Architecture hôte-autoritaire :
l'hôte simule toute la guerre, l'invité envoie ses ordres (construction, axe,
améliorations) et reçoit des instantanés à 10 Hz.

Le jeu utilise le `NetworkManager` de BGEW et parle au serveur officiel
`bgew.stevecohen.fr` par défaut. **Ce serveur était injoignable en juin 2026**
(proxy Apache en erreur SSL) ; en attendant, `tools/server.mjs` implémente
exactement le même protocole (REST rooms + WebSocket) :

```bash
npm run server                       # écoute sur :8090
# puis ouvrir le jeu avec :
http://localhost:5050/?server=localhost:8090
# pour jouer en LAN, partager :
http://<ip-locale>:5050/?server=<ip-locale>:8090
```

Sans `?server=`, le jeu vise le serveur officiel — rien à changer le jour où il
revient.

## Comment jouer

- Les unités sortent toutes seules des casernes et des usines et poussent le
  front. Votre armée se déploie sur ≈ 6 colonnes de part et d'autre de l'**AXE**
  (touchez le bouton puis une colonne).
- **L'or** : 120 au départ, +3/s, +1 par case conquise, +25 par coffre, primes
  sur les ennemis abattus.
- **Ligne du bas — bâtiments et ordres** : CASERNE, TOURELLE, USINE (le prix
  monte avec le nombre que vous possédez, et retombe si on vous en détruit),
  HELICO (appui-feu sur une colonne, seules les tourelles l'abattent), FRAPPE
  (bombardement de zone, alliés compris).
- **Ligne du milieu — FORCE** et **ligne du haut — DÉFENSE** : deux voies
  d'amélioration séparées pour les soldats, les tanks, les tourelles et les
  hélicos. Galons dorés (force) et bleus (défense) au-dessus des unités.
- **Le QG est une forteresse** qui tire des obus à éclats et lève deux vagues
  de défense. **Mort subite à 6:00** : le QG du camp qui tient le moins de
  territoire s'effrite.

Tous les chiffres sont dans `src/balance.ts` ; la méthode d'équilibrage et les
mesures dans `BALANCE.md`.

## L'IA : un commandant entraîné par auto-jeu

En solo, l'armée rouge est jouée par un **commandant** (`src/commander.ts`) qui
donne ses ordres par le même chemin qu'un humain : même or, mêmes prix, aucune
unité gratuite. Son comportement tient dans un **génome** (poids de dépense,
seuils, réactions). Les niveaux FACILE et MOYEN utilisent une doctrine de base
avec des handicaps (réflexion lente, hésitations, moins d'or au départ) ;
DIFFICILE et IMBATTABLE utilisent la doctrine **entraînée** (`src/trained.ts`).

```bash
npm run train          # entraînement sans affichage (le plus rapide, pour la nuit)
npm run train:show     # mur de batailles sur tous les écrans (10 par écran)
node tools/train.mjs --show --screens 2,3 --cols 6 --rows 3 --speed 8
npm run lab            # tournoi d'équilibrage entre styles de jeu
```

L'entraînement ne coûte rien (aucun appel à l'API) : une population de génomes
s'affronte, les meilleurs survivent, se croisent et mutent. L'état est sauvé
dans `training/` à chaque génération (relancer reprend où on en était, `--fresh`
repart de zéro) et le champion est écrit dans `src/trained.ts`. Ctrl+C sauve
et exporte.

## Niveau CLAUDE (privé)

Cinquième niveau solo : le commandant entraîné joue en continu, et un **vrai
modèle Claude** (Anthropic) est son stratège. Toutes les ~20 s, le jeu envoie à
la Cloud Function `claudeTurn` un rapport (ce que vous voyez à l'écran + ce que
VOUS avez fait : bâtiments, améliorations, frappes, axe) ; Claude renvoie une
**doctrine** que le commandant applique aussitôt, et une réplique affichée sous
la barre de territoire. Le commandant n'attend jamais le général : si le
serveur ne répond pas, la partie continue. Le niveau est protégé par **mot de
passe** pour le moment (clé API et facture). Voir `functions/README.md`.

Tests : `node tools/claude-test.mjs` (Chromium headless, fonction simulée :
menu, mot de passe, rapports, doctrine appliquée, mode dégradé, refus) et
`node tools/claude-function-test.mjs` (module de la fonction, sans réseau).

## Assets (tous CC0 / libres)

| Asset | Source | Licence |
| --- | --- | --- |
| Sprites (unités, bâtiments, décors) | [Kenney — Tiny Battle](https://kenney.nl/assets/tiny-battle) | CC0 |
| Tirs, explosions | [Kenney — Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds) | CC0 |
| Clics, or, construction, erreur | [Kenney — Interface Sounds](https://kenney.nl/assets/interface-sounds) | CC0 |
| Jingles victoire/défaite | [Kenney — Music Jingles](https://kenney.nl/assets/music-jingles) | CC0 |
| Musique de bataille | [Cynic Battle Loop](https://opengameart.org/content/cynic-battle-loop) — cynicmusic.com / pixelsphere.org (compo originale : Alex Smith) | CC0 |
| Police titre | [Black Ops One](https://fonts.google.com/specimen/Black+Ops+One) | OFL |
