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

## Améliorer les soldats

Le bouton **SOLDATS+** monte le niveau de vos soldats (1 → 5) : +1 PV, +0,5
dégât, +5 portée, +5 vitesse et cadence +5 % par niveau. Le coût croît
(80, 160, 240, 320 or) et chaque caserne produit au niveau courant — les
vétérans déjà déployés gardent le leur (chevrons dorés au-dessus du casque).
En solo, l'IA rouge achète aussi ses niveaux.

## Comment jouer

- Les unités sortent toutes seules des casernes et poussent le front.
- **L'or** vient des cases conquises (+1), des coffres (+25) et des ennemis
  abattus (+3 soldat, +10 tank, +20/30 bâtiment).
- **CASERNE** (50), **TOURELLE** (75), **USINE** (120) : touchez le bouton puis
  une case à vous, libre.
- **SOLDATS+** : améliore vos soldats (5 niveaux, voir plus bas).
- **FRAPPE** (100) : bombardement de zone après un court délai — dégâts pour
  TOUT le monde dans le rayon, alliés compris.
- **AXE** : touchez une colonne — vos troupes convergeront dessus.
- **Le QG est une forteresse** : 150 PV et il tire. Le rush direct meurt sur
  ses canons — il faut gagner le front d'abord.
- L'IA rouge pense toutes les 3 s, lève une **garnison d'urgence** quand son
  QG est menacé, achète ses propres améliorations et frappes, et son revenu
  augmente avec le temps : traîner, c'est perdre.

## Assets (tous CC0 / libres)

| Asset | Source | Licence |
| --- | --- | --- |
| Sprites (unités, bâtiments, décors) | [Kenney — Tiny Battle](https://kenney.nl/assets/tiny-battle) | CC0 |
| Tirs, explosions | [Kenney — Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds) | CC0 |
| Clics, or, construction, erreur | [Kenney — Interface Sounds](https://kenney.nl/assets/interface-sounds) | CC0 |
| Jingles victoire/défaite | [Kenney — Music Jingles](https://kenney.nl/assets/music-jingles) | CC0 |
| Musique de bataille | [Cynic Battle Loop](https://opengameart.org/content/cynic-battle-loop) — cynicmusic.com / pixelsphere.org (compo originale : Alex Smith) | CC0 |
| Police titre | [Black Ops One](https://fonts.google.com/specimen/Black+Ops+One) | OFL |
