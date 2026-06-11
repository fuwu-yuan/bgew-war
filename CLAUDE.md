# CLAUDE.md — Tout ce qu'il faut savoir sur BGEW

Ce projet utilise **BGEW** (`@fuwu-yuan/bgew`), le « Baguette Game Engine Web » —
moteur 2D canvas TypeScript écrit par Steve Cohen (le propriétaire de ce repo) et
Julien Béguier. Source : https://github.com/fuwu-yuan/bgew
Ce fichier condense l'analyse complète du moteur faite en juin 2026 (projet
`../bgew-claude`, jeu NEON VORTEX) : **ne pas re-analyser le moteur**, tout est ici.

## Installation & build

- **npm n'a que la 1.13.0** (le GitHub affiche 1.14.0, jamais publiée).
  → `"@fuwu-yuan/bgew": "^1.13.0"`. Une `^1.14.0` casse `npm install` (ETARGET).
- Pas de framework : esbuild + serve suffisent.
  ```json
  "build": "esbuild src/main.ts --bundle --outfile=dist/bundle.js --format=esm --sourcemap",
  "serve": "serve -l 5050",
  "typecheck": "tsc --noEmit"
  ```
- `index.html` : un `<div id="game"></div>`, le moteur y crée son canvas.
- Dépendances embarquées par le moteur : howler (son), detect-collisions, rxjs,
  stats.js, worker-timers. L'import shim global `window.global = window` est dans
  l'index du paquet — ne fonctionne **que dans un navigateur** (un `require` Node pur
  crash : `window is not defined`). Ne jamais importer bgew dans un script Node.

## Architecture du moteur

```
Board (canvas + gameloop + steps + sons + events)
 └── GameStep (écran : menu, jeu, gameover…) — possède une Camera et des Timers
      └── Entity[] (sur le board, PAS par step : board.entities est global)
```

- **`Board(name, version, width, height, htmlElem, background, enableHIDPI=false, enableCollisionSystem=true)`**
  - `board.config.game.FPS` : **30 par défaut → mettre 60**.
  - `board.start()` lance la gameloop ; chaque tick : resize canvas (efface tout),
    dispatch inputs, `step.update(delta_ms)`, collisions, `step.draw()`.
  - `board.addEntity / removeEntity / addEntities / removeEntities / findEntity(id)`.
  - `board.addSteps([...])` + `board.step = firstStep` (setter direct, sans onEnter)
    puis `board.moveToStep(name, data)` pour les transitions (onLeave → reset →
    onEnter). `reset()` **supprime toutes les entités** et appelle `onDestroy()`.
  - Sons (Howler) : `registerSound(name, src, repeat, volume)` puis
    `playSound(name, repeat?, volume?)`, `stopSound(name, fadeout?, ms?)`.
  - `board.onMouseEvent(type, cb(event, x, y))` / `board.onKeyboardEvent(type, cb)` :
    écouteurs globaux. x,y déjà convertis en coordonnées canvas (PAS caméra).
- **`GameStep`** : abstraite — `name`, `onEnter(data)`, `onLeave()`, `update(delta)`,
  `draw()`. `delta` est en **millisecondes**. `step.camera.x/y` est soustrait au
  contexte avant le dessin des entités (translate). `addTimer(ms, cb, repeat)`.
- **`Entity`** : abstraite — x, y, width, height, speedX/speedY (px/s, intégrés
  automatiquement par `update` parent), rotate (setter en **degrés**, stocké radians),
  zoom, opacity, visible, disabled, focus, id. `draw(ctx)` doit appeler `super.draw(ctx)`
  (applique opacity + scale). `update(delta)` parent intègre vitesse + gravité.
- **`Entities.*` fournis** : Rectangle (coins arrondis, états hover/click), Oval,
  Line, Label, Button (très complet : hover/click/disabled + curseur), InputText,
  Checkbox, Image, SpriteSheetImage (animations par frames), Video, Container
  (enfants en coordonnées relatives).
- **Réseau** : `NetworkManager` (rooms/join/messages) pointe sur le serveur de Steve —
  ignorer pour du solo.

## Pièges connus (tous vérifiés en conditions réelles)

1. **Pas de z-order** : ordre de dessin = ordre de `board.entities`. Pour garder un
   HUD au-dessus, re-pousser l'entité en fin de tableau à chaque frame
   (`splice` + `push` — le tableau est public).
2. **`moveToStep(..., fade)` dessine son rectangle en coordonnées monde (0,0)** :
   inutilisable si la caméra bouge. Faire son propre `Fader` (entité plein écran
   dessinée en `camera.x/y`) avec callback de fin → puis `moveToStep` sans fade.
3. **`board.pause()` fige update ET draw, mais le resize du canvas continue
   d'effacer l'écran** → écran noir. Implémenter la pause dans le step :
   `if (this.paused) return;` en tête de `update()` en laissant `draw()` tourner.
4. **Dispatch souris** : un clic est testé contre **toutes** les entités dans la même
   passe. Si un handler rend visible une entité sous le curseur, elle reçoit le même
   clic. Garde : flag + `setTimeout(0)`. Les entités avec `disabled = true` ou
   `visible = false` sont ignorées par le dispatch (perf : mettre `disabled = true`
   sur toute entité gameplay non cliquable).
5. **Événements clavier par entité** : seulement si l'entité a le `focus` (donné par
   clic). Pour un jeu : `board.onKeyboardEvent` global, enregistré **une fois dans le
   constructeur du step** avec garde `if (board.step !== this) return;` (les
   écouteurs board survivent aux changements de step, et `onEnter` peut être rappelé
   → jamais enregistrer dans `onEnter` sous peine de doublons).
6. **Collision system (detect-collisions/BVH)** : les bodies sont insérés à
   `addEntity` et le système est mis à jour chaque tick. Avec des centaines
   d'entités (particules !), c'est un coût inutile → le désactiver :
   `new Board(..., false)` et faire ses tests cercle-cercle maison.
7. **`Entity.speed` existe déjà** (accesseur magnitude de speedX/speedY) : ne jamais
   déclarer une propriété `speed` dans une sous-classe (TS2610). Idem `angle`.
8. **`Label.width`** mesure le texte via le ctx passé **au constructeur** — toujours
   passer `board.ctx`. Centrage : `label.x = W/2 - label.width/2` après config police.
9. **fr-FR `toLocaleString`** insère U+202F (espace fine insécable) — Orbitron et
   d'autres webfonts n'ont pas le glyphe sur canvas → `.replace(/[  ]/g, " ")`.
10. **`update(0)` au constructeur de SpriteSheetImage** : l'image n'est pas encore
    chargée (width 0) — les dimensions se calculent au premier update où l'image est
    prête ; prévoir un frame de latence.
11. Le canvas est recréé en taille à chaque tick (`canvas.width = ...` dans la loop) :
    tout état ctx (font, shadow…) est volatile — tout re-spécifier dans chaque `draw`.
12. L'audio nécessite un geste utilisateur (politique navigateur) : prévoir un
    hint « cliquez pour activer le son » au menu.

## Patterns qui marchent bien (copiables depuis ../bgew-claude)

- **`GameObject`** (src/entities/gameobject.ts) : base hitbox circulaire, coordonnées
  centre (`cx/cy`), flag `dead` + balayage `sweep()` par le step qui `removeEntity`
  les morts à la fin de chaque update. Toutes les listes typées (enemies, bullets,
  effects…) sont des tableaux du step, l'entité est aussi dans `board.entities`.
- **Caméra** : `camera.x = lerp(...)` vers la cible + screen-shake additif
  (`shakeP *= damp(7, dt)`), HUD dessiné en `ctx.translate(camera.x, camera.y)`
  pour rester fixe à l'écran.
- **Amortissements frame-rate independent** : `damp(rate, dt) = Math.exp(-rate*dt)`.
- **Néon canvas** : `shadowColor` + `shadowBlur` + `globalCompositeOperation =
  "lighter"` pour les particules/glow ; formes vectorielles plutôt que sprites.
- **Sons procéduraux** : `../bgew-claude/tools/generate-sounds.mjs` — synthé WAV
  16 bits complet (osc/noise/env/echo/softclip + writer) : copier et adapter les
  recettes plutôt que chercher des assets.
- **Tests headless** : `playwright-core` (devDependency) + Chromium en cache
  `~/Library/Caches/ms-playwright/chromium_headless_shell-*/...` ; petit serveur
  http Node intégré au script de test (voir `../bgew-claude/tools/smoke-test.mjs` et
  `deathrun-test.mjs`). Lancer avec `--autoplay-policy=no-user-gesture-required`,
  collecter `pageerror`/console.error, cliquer/jouer, capturer des PNG dans /tmp
  puis les lire pour vérifier visuellement. **Toujours vérifier ainsi avant de livrer.**

## Projet de référence

`../bgew-claude` = NEON VORTEX, twin-stick shooter complet (menu/jeu/gameover, vagues,
boss, power-ups, HUD, musique synthwave) construit sur ces patterns, testé sans erreur.
S'en servir comme bibliothèque d'exemples : starfield parallaxe, grille néon, particules,
faders, boutons stylés, popups de score, persistance localStorage.
