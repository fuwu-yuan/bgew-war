/**
 * Enregistrement d'une partie solo : de quoi la REJOUER à l'identique (la sim
 * est déterministe) — graine, carte de départ, équilibrage, et tous les ordres
 * exécutés par les deux camps avec leur tick. Sert à l'apprentissage du bot.
 */
import type { MapInitData } from "./entities/tilemap";
import type { CmdMsg } from "./network";

/** Un ordre exécuté : `t` = tick de sim, `p` = phase dans le tick (0 = ordres
 *  planifiés, avant l'avance du monde ; 1 = ordres de l'IA, après). */
export type RecordedCmd = Omit<CmdMsg, "type"> & { t: number; p: 0 | 1 };

export interface SoloRecord {
  version: string;
  difficulty: string;
  seed: number;
  map: MapInitData;
  cmds: RecordedCmd[];
  /** JSON de l'équilibrage (BAL) en vigueur pendant la partie. */
  bal: string;
  ticks: number;
  time: number; // s
  win: boolean; // le joueur (bleu) a gagné
  share: number; // part de carte bleue à la fin
}
