# BGEW WAR — Game Design Document

> Reproduction du jeu aperçu dans la pub Instagram « **War Inc: Rising** » (sponsorisé,
> octobre 2025). La pub est un *fake gameplay* : le jeu n'existe pas — on va le faire
> exister avec BGEW. Source analysée : `ScreenRecording_10-28-2025 18-32-15_1.MP4`
> (19 s, 60 fps, capture verticale de téléphone).

---

## 1. Ce qu'on voit dans la pub (analyse frame par frame)

### Concept général

Une **guerre de territoire en tir à la corde (tug-of-war)** entre deux armées sur une
carte quadrillée vue du dessus :

- **Armée rouge/rose** : moitié haute de la carte.
- **Armée bleue** : moitié basse.
- Chaque **case** du damier appartient à un camp (rose clair/foncé en damier côté rouge,
  bleu clair/foncé côté bleu). La **ligne de front** est la frontière irrégulière où les
  deux couleurs se rencontrent — elle **ondule en permanence** : le bleu perce au centre,
  le rouge contre-attaque sur un flanc, etc. C'est l'image-signature du jeu.

### La carte

- Damier d'environ **20 colonnes × ~28 rangées** visibles (cases ~44 px sur une capture
  888 px de large).
- Style **voxel/3D isométrique léger** : la carte est un plateau de cubes posé sur un
  océan ; les cases du bord ont une tranche visible (falaise) avec un liseré de sable
  jaune ; le contour du plateau est **irrégulier** (côte découpée, pas un rectangle).
- Les cases conquises **changent de couleur instantanément** au passage du front.
- Décor par camp : arbres roses en zone rouge, arbres bleu-sarcelle en zone bleue,
  rochers, tonneaux, caisses — posés sur certaines cases.

### Les unités

- **Infanterie** : petits soldats (2 ou 3 par case max) qui **marchent en colonnes
  vers le front**, chacun dans le camp adverse de sa couleur. Ils tirent en continu :
  on voit des **traînées de balles en pointillés** (lignes de petits points blancs/jaunes)
  entre les tireurs et leurs cibles. Quand deux groupes se rencontrent, échanges de tirs,
  petites **explosions oranges** et disparition des perdants.
- **Véhicules/tanks** (plus rares, surtout côté bleu en bas à droite) : plus gros,
  plus lents, plus résistants.
- Les unités **spawent en continu** depuis les bâtiments de production de leur camp et
  se dirigent globalement vers la ligne de front (flux constant, pas de micro-gestion
  visible — c'est un jeu d'**auto-battler territorial**).

### Les bâtiments (posés sur des cases, avec base/socle)

| Bâtiment | Aspect | Rôle déduit |
| --- | --- | --- |
| **QG rouge** | Château/forteresse rose avec bannières, en haut au centre | Cœur du camp rouge — le détruire = victoire |
| **QG bleu** | Trône violet avec **couronne dorée**, en bas au centre | Cœur du camp bleu |
| **Casernes** | Petits forts avec drapeau du camp (plusieurs par camp, alignés en arrière du front) | Spawn d'infanterie en continu |
| **Usines** | Bâtiments avec icône véhicule | Spawn de tanks |
| **Tourelles** | Tours rondes à dôme (bleu/violet) | Défense fixe : tirent sur tout ce qui approche (traînées pointillées) |
| **Caisses / tonneaux / coffres dorés** | Posés sur des cases neutres ou en arrière | Ressources/bonus à ramasser, tonneaux explosifs |

### Effets visuels remarqués

- Explosions : éclats oranges + fumée brève à chaque mort/impact.
- Tirs : pointillés rectilignes courts (balles), arcs pour l'artillerie.
- Conquête : la case bascule de couleur d'un coup (flash léger).
- Caméra **fixe** (toute la carte visible en hauteur), légère ondulation de l'eau autour.
- Aucune UI de jeu visible dans la pub (pas de barre de ressources ni de main du
  joueur) : c'est une simulation qui tourne toute seule — la pub vend le *spectacle*
  du front qui bouge.

### Boucle de gameplay supposée (à concevoir, la pub ne montre rien)

La pub ne montre aucune interaction. Pour en faire un **vrai** jeu, on ajoute le rôle
du joueur : il commande le camp bleu :

1. **Placer/améliorer des bâtiments** (caserne, usine, tourelle) sur ses cases avec
   l'or gagné (cases conquises + coffres + kills).
2. Les unités sortent toutes seules et poussent le front — le joueur peut
   **désigner un axe d'attaque** (taper une case cible pour concentrer le flux).
3. **Victoire** : atteindre/détruire le QG adverse. **Défaite** : perdre le sien.

---

## 2. Adaptation BGEW — spécification technique

### Vue et carte

- Board **portrait 640×1024** (le jeu est vertical comme la pub), FPS 60.
- Carte **16 colonnes × 24 rangées**, cases de 40 px → 640×960, HUD sur la bande basse.
- Caméra fixe (`camera.x/y = 0`) : pas de scrolling, toute la carte à l'écran.
- La carte = **une seule entité `TileMap`** qui dessine le damier, les tranches
  « falaise » du bord, le sable, l'océan animé en fond et le flash de conquête.
  Stockage : `Uint8Array` (0 = trou/eau, 1 = rouge, 2 = bleu) + table des décors.
  **Ne jamais faire une entité BGEW par case** (384 cases = trop de dispatch).
- Contour irrégulier : masque généré (bruit sur les bords) au chargement du niveau.

### Entités gameplay (pattern NEON VORTEX, voir CLAUDE.md)

- Base `GameObject` maison : hitbox cercle, coordonnées centre, flag `dead`,
  `disabled = true` (pas d'événements souris sur les unités).
- **Soldier** : PV 3, vitesse ~55 px/s, cadence 1 tir/s, portée 90 px. IA : avancer
  vers la case ennemie la plus proche de l'axe d'attaque ; s'arrêter à portée d'un
  ennemi et tirer ; sinon avancer et **convertir la case** sous ses pieds.
- **Tank** : PV 12, vitesse 30, dégâts 3, portée 120. Même IA.
- **Bullet** : pointillé court orienté (comme la pub), durée de vie < 1 s.
- **Building** (caserne/usine/tourelle/QG) : PV, timer de spawn (`board.addTimer`),
  appartenance. La tourelle tire sur l'unité ennemie la plus proche (portée 150).
- **Effets** : réutiliser `Particle`/`Shockwave`/`ScorePopup` de NEON VORTEX
  (explosions oranges, flash de conquête, +or).

### La ligne de front (le cœur du jeu)

- La « ligne » n'est pas simulée séparément : elle **émerge** de la conversion de
  cases par les unités. Une unité convertit la case qu'elle occupe si la case est
  adverse et qu'aucun ennemi n'est à portée.
- Spawn : chaque caserne émet 1 soldat / 2,5 s (file de spawn plafonnée à ~80 unités
  par camp pour tenir 60 fps).
- IA rouge (l'adversaire) : mêmes règles + un « cerveau » simple qui replace ses
  casernes vers les zones où son front recule (toutes les 10 s).

### Performance (384 cases + ~160 unités + balles)

- Collisions : **système BGEW désactivé** (`new Board(..., false)`), tests
  cercle-cercle maison + **grille spatiale** (bucket par case) pour le ciblage
  (jamais de O(n²) sur les unités).
- Une entité = un objet dessiné ; le damier, les décors et l'eau = 1 entité chacun.

### Steps

1. `menu` — titre + JOUER (pattern NEON VORTEX réutilisable tel quel).
2. `game` — la bataille ; HUD bas : or, boutons de construction (caserne 50,
   tourelle 75, usine 120), bouton « axe d'attaque ».
3. `victory` / `defeat` — stats (cases conquises, unités perdues, durée) + rejouer.

### Sons (générateur procédural à copier de bgew-claude)

`tools/generate-sounds.mjs` : tirs courts (tick), explosion, conquête (blip montant),
construction (marteau), fanfare victoire/défaite, musique militaire 8 bars en boucle
(caisse claire + cuivres synthétiques).

### Étapes de dev suggérées

1. TileMap + océan + contour (statique, joli d'abord — c'est l'identité visuelle).
2. Soldats qui marchent, tirent, meurent, convertissent — front émergent entre 2 IA.
3. Bâtiments + spawn + tourelles + QG + conditions de victoire.
4. Interaction joueur (or, construction, axe d'attaque) + HUD.
5. Sons, polish (explosions, flashs, popups), menu/fin, tests Playwright headless.

---

## 3. Captures de référence

Frames extraites de la pub : `ffmpeg -i <video> -vf "fps=1,scale=444:960" /tmp/vortex-ad/f%02d.png`
— moments clés : f01 (vue d'ensemble), f07/f10 (le bleu perce au centre), f13/f16
(contre-attaque rouge), crop-frontline (détail unités/tirs), crop-red-top (QG et
casernes rouges), crop-blue-bottom (trône bleu à couronne, tourelles, usines).
