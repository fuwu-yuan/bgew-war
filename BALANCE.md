# Équilibrage — méthode et état (v1.10.0)

Tous les chiffres de gameplay vivent dans `src/balance.ts` (`BAL`). Ne jamais en
recopier ailleurs.

## Le banc d'essai

- `node tools/balance-lab.mjs` — tournoi entre **styles de jeu scriptés** (les deux
  camps joués par le même type de commandant, IA du jeu coupée), en accéléré et en
  parallèle. Sort la durée des parties, la matrice de victoires style × style, la
  symétrie rouge/bleu, les changements de meneur et les remontées.
  - `--variant f.json` : surcharge de `BAL` à chaud (tester sans recompiler).
  - `--styles a,b,c`, `--seeds N`, `--workers N`, `--out f.json`, `--mirror`.
  - Styles « ablation » (`no_heli`, `no_strike`, `no_turret`, `no_tank`,
    `no_upgrade`) : le joueur complet privé d'UN outil. Si « sans X » fait aussi
    bien que `mixed`, X ne sert à rien.
- `node tools/balance-duel.mjs '{"soldiers":40}' '{"tanks":5}'` — duel isolé sans
  production : valeur d'échange réelle des unités.
- `node tools/balance-shot.mjs <rouge> <bleu> <seed> <dossier>` — captures d'une
  partie du banc à intervalles réguliers, pour VOIR ce que font les armées.

## Ce qui a changé en v1.10.0 et pourquoi

Avant : toutes les parties duraient ≈ 1 min quel que soit le style, 0-10 % de
remontées. Cause : économie explosive (prime de 3 or par soldat + caserne à 50 or
produisant 12 soldats/8 s → revenus qui doublent toutes les ≈ 8 s), bâtiments et
QG en papier, armées en colonne qui se croisent sans se battre.

| Levier | Avant | Après |
| --- | --- | --- |
| Caserne | 36 pv, 12 soldats/8 s | 120 pv, 6 soldats/8 s |
| Usine | 48 pv, 5 tanks/12 s | 160 pv, 2 tanks/12 s |
| Prix des bâtiments | fixe | croissant (caserne ×1,35 après 3, usine ×1,5, tourelle ×1,15 après 3), retombe à la destruction |
| Primes | soldat 3, tank 10 | soldat 1, tank 8 |
| QG | 320 pv, 4 dégâts | 1800 pv, obus 6 dégâts à éclats (40 px) |
| Défense du QG | 1 vague énorme | 3 vagues par paliers de pv (16-50 soldats, 1-5 tanks) |
| Tourelle | 75 or, 30 pv, 3 dégâts/0,55 s | 60 or, 240 pv, 4 dégâts/0,5 s |
| Tank | portée 120 | portée 140 (sous la tourelle : 150) |
| Niveaux soldats | 80×n^1,18, +3 pv +0,5 dégât | 110×n^1,35, +2 pv +0,25 dégât |
| Frappe | 100 or, rayon 75, 12/10 dégâts | 60 or, rayon 105, 16/60 dégâts |
| Hélico | 150 or, traverse la carte | 100 or, ralentit pour mitrailler, 22 s d'autonomie, n'entre pas dans la base |
| Largeur d'armée | ±100 px autour de l'axe | ±260 px (un vrai front) |
| Mort subite | — | à 7:00, le QG du camp minoritaire en territoire s'effrite |

Corrections au passage : les unités arrivées au fond de la carte assiègent le QG
(elles restaient plantées au bord → parties gelées) ; coffres placés
symétriquement (le rouge en ramassait plus).

## Résultat mesuré (605 parties, 11 styles)

Durée médiane 5:53 (10 % < 3:28, 90 % < 8:25), aucun nul, rouge 48 % / bleu 52 %,
1,65 changement de meneur par partie, 29 % de remontées. Meilleurs styles :
frappes 71 %, infanterie 69 %, blindés 66 %, complet 58 % — aucun n'écrase les
autres (infanterie < blindés < frappes < infanterie à ≈ 60-70 %).

## Dette connue

- L'IA solo (`redBrain`, niveaux DIFFICILE / IMBATTABLE / CLAUDE) a été écrite pour
  les anciens chiffres : elle est à recalibrer (chantier auto-jeu).
- Poser ses casernes SUR le front (style `expander`) perd presque toujours : le
  chantier meurt. À 1-2 rangées derrière, c'est viable.
- Hélicos seuls (`air`) : faibles ; utiles en appoint contre un adversaire sans tourelle.
