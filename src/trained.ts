/**
 * Génome ENTRAÎNÉ par auto-jeu — fichier généré par tools/train.mjs, ne pas
 * modifier à la main (relancer l'entraînement). Génération 12,
 * 1536 parties jouées, score 102 % contre ses adversaires d'entraînement.
 */
import type { Genome } from "./commander";

export const TRAINED_GENERATION = 12;

export const TRAINED_GENOME: Genome = {
  "w": {
    "barracks": 2.21,
    "factory": 1.647,
    "turret": 0,
    "strike": 3.52,
    "heli": 0.606,
    "soldierAtk": 1.009,
    "soldierDef": 0.672,
    "tankAtk": 0.28,
    "tankDef": 0.483,
    "turretAtk": 0,
    "turretDef": 0.106,
    "heliAtk": 0,
    "heliDef": 0
  },
  "bank": 40.149,
  "strikeMin": 10.325,
  "turretShare": 0.642,
  "heliMaxAA": 5.767,
  "backMin": 2.599,
  "backSpan": 3.463,
  "spread": 2.054,
  "axAdvance": 1.476,
  "axEnemy": 0.57,
  "axisHold": 1.413,
  "defendRadius": 284.96,
  "ecoUntil": 0,
  "ecoBoost": 1.761,
  "vsTanks": 1.025,
  "vsMass": 1.171,
  "vsAir": 2.606,
  "maxBarracks": 9.726,
  "maxFactories": 6,
  "maxTurrets": 11.132
};
