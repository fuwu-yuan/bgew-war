/**
 * Génome ENTRAÎNÉ par auto-jeu — fichier généré par tools/train.mjs, ne pas
 * modifier à la main (relancer l'entraînement). Génération 274,
 * 35143 parties jouées, score 100 % contre ses adversaires d'entraînement.
 */
import type { Genome } from "./commander";

export const TRAINED_GENERATION = 274;

export const TRAINED_GENOME: Genome = {
  "w": {
    "barracks": 1.421,
    "factory": 0.308,
    "turret": 0,
    "strike": 4.798,
    "heli": 0,
    "soldierAtk": 0.098,
    "soldierDef": 0.534,
    "tankAtk": 0,
    "tankDef": 0.04,
    "turretAtk": 0.396,
    "turretDef": 0,
    "heliAtk": 0.438,
    "heliDef": 0.772
  },
  "bank": 36.143,
  "strikeMin": 21.178,
  "turretShare": 0.774,
  "heliMaxAA": 4.232,
  "backMin": 5,
  "backSpan": 4.65,
  "spread": 1,
  "axAdvance": 2.1,
  "axEnemy": 3,
  "axisHold": 5.038,
  "defendRadius": 420,
  "ecoUntil": 63.648,
  "ecoBoost": 2.44,
  "vsTanks": 0.5,
  "vsMass": 1.777,
  "vsAir": 1.042,
  "maxBarracks": 8.1,
  "maxFactories": 3.59,
  "maxTurrets": 4.433
};
