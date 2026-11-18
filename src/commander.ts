/**
 * COMMANDANT — le cerveau local, pour N'IMPORTE QUEL camp.
 *
 * Un commandant lit le champ de bataille (ce qu'un joueur voit) et donne des
 * ordres par le même chemin qu'un humain (`CmdMsg`) : même or, mêmes prix,
 * mêmes validations. Aucun passe-droit.
 *
 * Tout son comportement tient dans un GÉNOME : une liste de nombres (poids de
 * dépense, seuils, réactions à ce que fait l'adversaire). C'est ce génome que
 * l'auto-jeu fait évoluer (tools/train.mjs) et que le général Claude ajuste
 * en cours de partie (niveau CLAUDE). Le code ci-dessous ne contient donc
 * aucune « stratégie » en dur : seulement la mécanique qui applique un génome.
 */
import { BAL, BuildKind, upgradeCost, UpgradeKind, UpgradeStat, UpLevels } from "./balance";
import type { Building } from "./entities/buildings";
import type { Helicopter } from "./entities/helicopter";
import type { TileMap } from "./entities/tilemap";
import type { Unit } from "./entities/units";
import { BLUE, enemyOf, Faction, GRID_H, GRID_W, MAP_H, RED, TILE } from "./globals";
import type { CmdMsg } from "./network";

/** Ce que le commandant peut lire du jeu (fourni par PlayStep.battleView()). */
export interface BattleView {
  readonly units: Unit[];
  readonly buildings: Building[];
  readonly helis: Helicopter[];
  readonly map: TileMap;
  readonly elapsed: number;
  gold(f: Faction): number;
  ups(f: Faction): Record<UpgradeKind, UpLevels>;
  axis(f: Faction): number;
  buildingAt(i: number): boolean;
  costOf(f: Faction, kind: BuildKind): number;
  /** La frappe aérienne de ce camp est-elle rechargée ? */
  strikeReady(f: Faction): boolean;
}

/** Catégories de dépense, dans l'ordre du génome. */
export const SPEND = [
  "barracks",
  "factory",
  "turret",
  "strike",
  "heli",
  "soldierAtk",
  "soldierDef",
  "tankAtk",
  "tankDef",
  "turretAtk",
  "turretDef",
  "heliAtk",
  "heliDef",
] as const;
export type Spend = (typeof SPEND)[number];

export interface Genome {
  /** Poids de dépense par catégorie : l'or va d'abord à la catégorie la plus
   *  en retard sur son poids (dépensé / poids). 0 = jamais. */
  w: Record<Spend, number>;
  /** Or gardé en banque (les constructions/améliorations n'y touchent pas). */
  bank: number;
  /** Soldats-équivalents détruits au minimum pour lancer une frappe. */
  strikeMin: number;
  /** Tourelles seulement si ma part de territoire est SOUS ce seuil (ou hélico ennemi). 1 = toujours. */
  turretShare: number;
  /** Hélico seulement si l'ennemi a au plus ce nombre de tourelles sur la colonne visée. */
  heliMaxAA: number;
  /** Bâtiments posés entre backMin et backMin + backSpan rangées derrière mon front. */
  backMin: number;
  backSpan: number;
  /** Demi-largeur (colonnes) autour de l'axe où je construis. */
  spread: number;
  /** Choix de l'axe : + avancée de mon front, − présence ennemie. */
  axAdvance: number;
  axEnemy: number;
  /** Secondes minimum entre deux changements d'axe (hors urgence). */
  axisHold: number;
  /** Ennemis à moins de cette distance (px) de mon QG → rappel de l'armée. */
  defendRadius: number;
  /** Avant `ecoUntil` s, le poids des casernes est multiplié par `ecoBoost`. */
  ecoUntil: number;
  ecoBoost: number;
  /** Réactions (multiplicateurs de poids) à ce que montre l'adversaire. */
  vsTanks: number; // usines + niveaux tanks quand il aligne des tanks
  vsMass: number; // frappes + tourelles quand son infanterie me déborde
  vsAir: number; // tourelles + niveaux tourelles quand il sort des hélicos
  /** Plafonds de bâtiments. */
  maxBarracks: number;
  maxFactories: number;
  maxTurrets: number;
}

/** Bornes de chaque gène (mutation, validation des consignes de Claude). */
export const GENE_BOUNDS: Record<Exclude<keyof Genome, "w">, [number, number]> = {
  bank: [0, 200],
  strikeMin: [3, 30],
  turretShare: [0.2, 1],
  heliMaxAA: [0, 6],
  backMin: [0, 5],
  backSpan: [0, 5],
  spread: [1, 8],
  axAdvance: [0, 3],
  axEnemy: [0, 3],
  axisHold: [0, 12],
  defendRadius: [120, 420],
  ecoUntil: [0, 240],
  ecoBoost: [1, 4],
  vsTanks: [0.5, 4],
  vsMass: [0.5, 4],
  vsAir: [0.5, 4],
  maxBarracks: [4, 14],
  maxFactories: [0, 6],
  maxTurrets: [2, 12],
};
export const WEIGHT_BOUNDS: [number, number] = [0, 6];

/** Génome de départ : un joueur complet et prudent (point de départ de l'évolution). */
export const BASE_GENOME: Genome = {
  w: {
    barracks: 2,
    factory: 1.5,
    turret: 1,
    strike: 1,
    heli: 0.7,
    soldierAtk: 1.2,
    soldierDef: 0.8,
    tankAtk: 0.5,
    tankDef: 0.5,
    turretAtk: 0.3,
    turretDef: 0.2,
    heliAtk: 0.2,
    heliDef: 0.2,
  },
  bank: 40,
  strikeMin: 8,
  turretShare: 0.47,
  heliMaxAA: 1,
  backMin: 2,
  backSpan: 3,
  spread: 3,
  axAdvance: 1.2,
  axEnemy: 0.6,
  axisHold: 3,
  defendRadius: 240,
  ecoUntil: 60,
  ecoBoost: 1.5,
  vsTanks: 1.5,
  vsMass: 1.5,
  vsAir: 2,
  maxBarracks: 10,
  maxFactories: 4,
  maxTurrets: 8,
};

/** Copie profonde + remise dans les bornes (toute valeur douteuse → base). */
export function sanitizeGenome(g: Partial<Genome> | null | undefined, base: Genome = BASE_GENOME): Genome {
  const num = (v: unknown, lo: number, hi: number, d: number): number => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d;
  };
  const src = g ?? {};
  const w = {} as Record<Spend, number>;
  for (const k of SPEND) w[k] = num(src.w?.[k], WEIGHT_BOUNDS[0], WEIGHT_BOUNDS[1], base.w[k]);
  const out = { w } as Genome;
  for (const k of Object.keys(GENE_BOUNDS) as (keyof typeof GENE_BOUNDS)[]) {
    out[k] = num(src[k], GENE_BOUNDS[k][0], GENE_BOUNDS[k][1], base[k]);
  }
  return out;
}

const UP_OF: Partial<Record<Spend, [UpgradeKind, UpgradeStat]>> = {
  soldierAtk: ["soldier", "atk"],
  soldierDef: ["soldier", "def"],
  tankAtk: ["tank", "atk"],
  tankDef: ["tank", "def"],
  turretAtk: ["turret", "atk"],
  turretDef: ["turret", "def"],
  heliAtk: ["heli", "atk"],
  heliDef: ["heli", "def"],
};

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

export class Commander {
  public genome: Genome;
  /** Or dépensé par catégorie (sert au choix « la plus en retard »). */
  public readonly spent: Record<Spend, number>;
  private readonly foe: Faction;
  private readonly dir: number; // sens de marche en rangées (+1 rouge, −1 bleu)
  private axisSince = -99;
  private seenHelis = new Set<number>();
  private helisLaunched = 0;

  constructor(
    private readonly view: BattleView,
    private readonly f: Faction,
    genome: Genome,
    private readonly issue: (cmd: CmdMsg) => void,
    /** Tirage [0, 1) — graine fournie par l'appelant (parties reproductibles au banc). */
    private readonly rng: () => number = Math.random
  ) {
    this.genome = genome;
    this.foe = enemyOf(f);
    this.dir = f === RED ? 1 : -1;
    this.spent = {} as Record<Spend, number>;
    for (const k of SPEND) this.spent[k] = 0;
  }

  private ri(a: number, b: number): number {
    return a + Math.floor(this.rng() * (b - a + 1));
  }

  private cmd(c: Omit<CmdMsg, "type" | "faction">): void {
    this.issue({ type: "cmd", faction: this.f, ...c } as CmdMsg);
  }

  /** Rangée la plus avancée tenue par `who` dans la colonne (−1 / GRID_H si aucune). */
  private frontRow(who: Faction, c: number): number {
    const m = this.view.map;
    if (who === RED) {
      for (let r = GRID_H - 1; r >= 0; r--) if (m.owner[m.idx(c, r)] === RED) return r;
      return -1;
    }
    for (let r = 0; r < GRID_H; r++) if (m.owner[m.idx(c, r)] === BLUE) return r;
    return GRID_H;
  }

  private canBuild(c: number, r: number): boolean {
    const m = this.view.map;
    if (c < 0 || c >= GRID_W || r < 1 || r > GRID_H - 2) return false;
    const i = m.idx(c, r);
    return m.isLand(c, r) && m.owner[i] === this.f && !this.view.buildingAt(i) && !m.hasChest(i);
  }

  private hq(who: Faction): Building | undefined {
    return this.view.buildings.find((b) => !b.dead && b.type === "hq" && b.faction === who);
  }

  private count(who: Faction, type: BuildKind): number {
    let n = 0;
    for (const b of this.view.buildings) if (!b.dead && b.faction === who && b.type === type) n++;
    return n;
  }

  /** Unités par colonne (tank = 2,5) pour les deux camps + totaux. */
  private census(): { mine: number[]; theirs: number[]; mySoldiers: number; foeSoldiers: number; foeTanks: number } {
    const mine = new Array<number>(GRID_W).fill(0);
    const theirs = new Array<number>(GRID_W).fill(0);
    let mySoldiers = 0;
    let foeSoldiers = 0;
    let foeTanks = 0;
    for (const u of this.view.units) {
      if (u.dead) continue;
      const c = clamp(Math.floor(u.cx / TILE), 0, GRID_W - 1);
      const v = u.isTank ? 2.5 : 1;
      if (u.faction === this.f) {
        mine[c] += v;
        if (!u.isTank) mySoldiers++;
      } else {
        theirs[c] += v;
        if (u.isTank) foeTanks++;
        else foeSoldiers++;
      }
    }
    return { mine, theirs, mySoldiers, foeSoldiers, foeTanks };
  }

  /** Axe : colonne où mon front est avancé et l'ennemi rare ; rappel si mon QG est menacé. */
  private chooseAxis(theirs: number[]): number {
    const g = this.genome;
    const hq = this.hq(this.f);
    if (hq) {
      let threats = 0;
      let tx = hq.cx;
      for (const u of this.view.units) {
        if (!u.dead && u.faction === this.foe && Math.hypot(u.cx - hq.cx, u.cy - hq.cy) < g.defendRadius) {
          threats++;
          tx = u.cx;
        }
      }
      if (threats >= 3) {
        this.axisSince = this.view.elapsed;
        return clamp(Math.floor(tx / TILE), 0, GRID_W - 1);
      }
    }
    const cur = this.view.axis(this.f);
    if (this.view.elapsed - this.axisSince < g.axisHold) return cur;
    let best = cur;
    let bestS = -Infinity;
    for (let c = 0; c < GRID_W; c++) {
      const fr = this.frontRow(this.f, c);
      if (fr < 0 || fr >= GRID_H) continue;
      const adv = this.f === RED ? fr : GRID_H - 1 - fr;
      const near = (theirs[c - 1] || 0) + theirs[c] + (theirs[c + 1] || 0);
      const s = adv * g.axAdvance - near * g.axEnemy + (c === cur ? 0.5 : 0); // légère inertie
      if (s > bestS) {
        bestS = s;
        best = c;
      }
    }
    if (best !== cur) this.axisSince = this.view.elapsed;
    return best;
  }

  private place(kind: BuildKind): boolean {
    const g = this.genome;
    const axis = this.view.axis(this.f);
    const span = Math.round(g.spread);
    for (let t = 0; t < 30; t++) {
      const c = clamp(axis + this.ri(-span, span), 0, GRID_W - 1);
      const fr = this.frontRow(this.f, c);
      if (fr < 0 || fr >= GRID_H) continue;
      const back = Math.round(g.backMin) + this.ri(0, Math.round(g.backSpan)) + (kind === "factory" ? 1 : 0);
      const r = clamp(fr - this.dir * back, 1, GRID_H - 2);
      if (this.canBuild(c, r)) {
        this.cmd({ cmd: "build", kind, c, r });
        return true;
      }
    }
    const hq = this.hq(this.f);
    if (!hq) return false;
    for (let t = 0; t < 20; t++) {
      const c = clamp(hq.col + this.ri(-5, 5), 0, GRID_W - 1);
      const r = clamp(hq.row + this.dir * this.ri(1, 6), 1, GRID_H - 2);
      if (this.canBuild(c, r)) {
        this.cmd({ cmd: "build", kind, c, r });
        return true;
      }
    }
    return false;
  }

  /** Meilleure cible de frappe : valeur détruite chez l'ennemi − chez moi. */
  private strikeTarget(): { x: number; y: number } | null {
    const R = BAL.strike.radius;
    const cands: { cx: number; cy: number; unit: boolean }[] = [];
    for (const u of this.view.units) if (!u.dead && u.faction === this.foe) cands.push({ cx: u.cx, cy: u.cy, unit: true });
    for (const b of this.view.buildings) {
      if (!b.dead && b.faction === this.foe && b.type !== "hq") cands.push({ cx: b.cx, cy: b.cy, unit: false });
    }
    let best: { cx: number; cy: number; unit: boolean } | null = null;
    let bestV = 0;
    const step = Math.max(1, Math.floor(cands.length / 40)); // ≤ 40 centres testés
    for (let k = 0; k < cands.length; k += step) {
      const p = cands[k];
      let v = 0;
      for (const u of this.view.units) {
        if (u.dead || Math.hypot(u.cx - p.cx, u.cy - p.cy) > R) continue;
        const worth = u.isTank ? 5 : 1;
        const frac = Math.min(1, BAL.strike.dmgUnit / u.hp);
        const val = frac >= 1 ? worth : worth * frac * 0.5;
        v += u.faction === this.foe ? val : -val;
      }
      for (const b of this.view.buildings) {
        if (b.dead || b.type === "hq" || Math.hypot(b.cx - p.cx, b.cy - p.cy) > R) continue;
        const frac = Math.min(1, BAL.strike.dmgBuilding / b.hp);
        const worth = b.type === "factory" ? 18 : b.type === "turret" ? 12 : 10;
        const val = frac >= 1 ? worth : worth * frac * 0.5;
        v += b.faction === this.foe ? val : -val;
      }
      if (v > bestV) {
        bestV = v;
        best = p;
      }
    }
    if (!best || bestV < this.genome.strikeMin) return null;
    // l'ennemi marche vers moi pendant la mèche : viser un peu devant lui
    const lead = best.unit ? -this.dir * 38 * BAL.strike.delay : 0;
    return { x: best.cx, y: clamp(best.cy + lead, TILE, MAP_H - TILE) };
  }

  /** Colonne d'hélico : la plus chargée en ennemis, si sa DCA y est assez faible. */
  private heliColumn(theirs: number[]): number | null {
    let best = -1;
    let bestV = 3; // au moins quelques cibles
    for (let c = 0; c < GRID_W; c++) {
      const v = (theirs[c - 1] || 0) + theirs[c] + (theirs[c + 1] || 0);
      if (v > bestV) {
        bestV = v;
        best = c;
      }
    }
    if (best < 0) return null;
    const x = best * TILE + TILE / 2;
    // tourelles ennemies qui couvrent la colonne, hors de sa base (l'hélico n'y entre pas)
    let aa = 0;
    for (const b of this.view.buildings) {
      if (b.dead || b.faction !== this.foe || b.type !== "turret") continue;
      const edge = this.foe === RED ? b.cy : MAP_H - b.cy; // distance au bord de SON camp
      if (edge < BAL.heli.turnBack - BAL.turret.range) continue;
      if (Math.abs(b.cx - x) < BAL.turret.range) aa++;
    }
    return aa <= this.genome.heliMaxAA ? best : null;
  }

  private costOf(cat: Spend): number {
    if (cat === "barracks" || cat === "factory" || cat === "turret") return this.view.costOf(this.f, cat);
    if (cat === "strike") return BAL.cost.strike;
    if (cat === "heli") return BAL.cost.helico;
    const [kind, stat] = UP_OF[cat]!;
    return upgradeCost(kind, stat, this.view.ups(this.f)[kind][stat]);
  }

  /** Un tour de réflexion : axe, puis au plus UN achat (celui qui est le plus en retard). */
  think(): void {
    const g = this.genome;
    const v = this.view;
    const f = this.f;
    const cen = this.census();

    const axis = this.chooseAxis(cen.theirs);
    if (v.axis(f) !== axis) this.cmd({ cmd: "axis", col: axis });

    // Ce que l'adversaire a montré
    for (const h of v.helis) {
      if (h.faction === this.foe && !this.seenHelis.has(h.nid)) {
        this.seenHelis.add(h.nid);
        this.helisLaunched++;
      }
    }
    const foeHeliUp = v.helis.some((h) => !h.dead && h.faction === this.foe);
    const share = v.map.share(f);
    const facingTanks = cen.foeTanks >= 4 || this.count(this.foe, "factory") >= 2;
    const outmassed = cen.foeSoldiers > cen.mySoldiers * 1.3 + 6;
    const airThreat = foeHeliUp || this.helisLaunched >= 2;

    // Poids effectifs du moment
    const w = {} as Record<Spend, number>;
    for (const k of SPEND) w[k] = g.w[k];
    if (v.elapsed < g.ecoUntil) w.barracks *= g.ecoBoost;
    if (facingTanks) {
      w.factory *= g.vsTanks;
      w.tankAtk *= g.vsTanks;
      w.tankDef *= g.vsTanks;
    }
    if (outmassed) {
      w.strike *= g.vsMass;
      w.turret *= g.vsMass;
    }
    if (airThreat) {
      w.turret *= g.vsAir;
      w.turretAtk *= g.vsAir;
      w.turretDef *= g.vsAir;
    }

    const myHelis = v.helis.filter((h) => !h.dead && h.faction === f).length;
    const eligible = (cat: Spend): boolean => {
      if (w[cat] <= 0) return false;
      if (cat === "barracks") return this.count(f, "barracks") < Math.round(g.maxBarracks);
      if (cat === "factory") return this.count(f, "factory") < Math.round(g.maxFactories);
      if (cat === "turret") {
        if (this.count(f, "turret") >= Math.round(g.maxTurrets)) return false;
        return share < g.turretShare || airThreat;
      }
      if (cat === "tankAtk" || cat === "tankDef") return this.count(f, "factory") > 0;
      if (cat === "turretAtk" || cat === "turretDef") return this.count(f, "turret") > 0;
      if (cat === "heliAtk" || cat === "heliDef") return this.spent.heli > 0;
      if (cat === "heli") return myHelis < BAL.heli.max;
      if (cat === "strike") return v.strikeReady(f);
      return true;
    };

    const cats = SPEND.filter(eligible).sort((a, b) => this.spent[a] / w[a] - this.spent[b] / w[b]);
    const gold = v.gold(f);
    for (const cat of cats) {
      const cost = this.costOf(cat);
      if (cat === "strike") {
        if (gold < cost) return; // économise pour la frappe
        const t = this.strikeTarget();
        if (!t) continue; // pas de cible : la banque reste, on regarde la suite
        this.cmd({ cmd: "strike", x: Math.round(t.x), y: Math.round(t.y) });
        this.spent.strike += cost;
        return;
      }
      if (cat === "heli") {
        if (gold < cost) return;
        const col = this.heliColumn(cen.theirs);
        if (col === null) continue; // DCA trop dense ou rien à mitrailler
        this.cmd({ cmd: "helico", x: col * TILE + TILE / 2 });
        this.spent.heli += cost;
        return;
      }
      if (gold < cost + g.bank) return; // économise pour la catégorie en retard
      if (cat === "barracks" || cat === "factory" || cat === "turret") {
        if (!this.place(cat)) continue;
      } else {
        const [kind, stat] = UP_OF[cat]!;
        this.cmd({ cmd: "upgrade", kind, stat });
      }
      this.spent[cat] += cost;
      return;
    }
  }
}
