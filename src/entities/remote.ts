import { Entity } from "@fuwu-yuan/bgew";
import { BLUE, GRID_H, MAP_H, RED, VIEW_W } from "../globals";
import { clamp, TAU } from "../utils";
import { drawSprite, SPR } from "../sprites";
import { drawLevelPips } from "./units";
import { BUILDING_SIZE, BUILDING_TYPES, BuildingType, drawBuildingBody } from "./buildings";
import { drawHeli } from "./helicopter";

interface RUnit {
  kind: number; // 0 soldier, 1 tank, 2 helico
  faction: number;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  hp: number;
  maxHp: number;
  level: number;
  walkP: number;
  moving: boolean;
}

interface RBuilding {
  type: BuildingType;
  faction: number;
  x: number;
  y: number;
  col: number;
  row: number;
  hp: number;
  maxHp: number;
  prog: number; // 0..1 — chantier (1 = opérationnel)
  t: number; // horloge d'animation (ouvrier)
}

// Render the world this far in the PAST, interpolating between the two latest
// snapshots by arrival time. Fixed (NOT adaptive: a changing buffer warps the
// timeline) and NO extrapolation (overshoot wobbles units that stop at the
// front). A late snapshot just holds the last position briefly.
const INTERP_DELAY = 0.1; // s

/**
 * Guest-side mirror of the host simulation: ONE entity that draws every remote
 * unit/building. Unit positions are interpolated on a delayed clock between the
 * last two snapshots (by arrival time), so jittery snapshot timing never shows.
 */
export class RemoteWorld extends Entity {
  private units = new Map<number, RUnit>();
  private buildings = new Map<number, RBuilding>();
  private clock = 0; // local seconds elapsed (advances every frame)
  private t0 = 0; // arrival time of the previous snapshot
  private t1 = 0; // arrival time of the latest snapshot
  private spawnIndex = new Map<number, number[]>(); // reused per-snapshot static-data lookup
  private hurtIndex = new Map<number, number>(); // reused per-snapshot damaged-units lookup

  constructor() {
    super(0, 0, VIEW_W, MAP_H);
    this.disabled = true;
  }

  get unitCount(): number {
    return this.units.size;
  }

  /** Real gap (ms) between the last two snapshot arrivals — exposes network jitter. */
  get lastGapMs(): number {
    return Math.round((this.t1 - this.t0) * 1000);
  }

  /** Interpolation buffer (ms). */
  get bufferMs(): number {
    return Math.round(INTERP_DELAY * 1000);
  }

  buildingAtTile(c: number, r: number): boolean {
    for (const b of this.buildings.values()) {
      if (b.col === c && b.row === r) return true;
    }
    return false;
  }

  /**
   * Ingest a host snapshot. `units` is DYNAMIC only ([nid, x, y, hp]); `spawns`
   * ([nid, kind, faction, maxHp, level]) carries each unit's STATIC data once.
   * View conversion is done inline (no per-snapshot array allocation).
   */
  applySnapshot(units: number[][], spawns: number[][], hurt: number[][], buildings: number[][], flipped: boolean): void {
    // Timestamp this snapshot's arrival; we interpolate between t0 and t1.
    this.t0 = this.t1;
    this.t1 = this.clock;

    // Index this snapshot's static data so newly-seen units can be created.
    const stat = this.spawnIndex;
    stat.clear();
    for (const s of spawns) stat.set(s[0], s);
    // Index the damaged units (everyone else is full-health).
    const hurtById = this.hurtIndex;
    hurtById.clear();
    for (const h of hurt) hurtById.set(h[0], h[1]);

    const seenU = new Set<number>();
    for (const r of units) {
      const nid = r[0];
      const x = r[1];
      const y = flipped ? MAP_H - r[2] : r[2];
      seenU.add(nid);
      const u = this.units.get(nid);
      if (u) {
        // Previous AUTHORITATIVE position becomes the from-point (not the
        // currently-rendered position) so timing jitter never causes a snap.
        u.fromX = u.toX;
        u.fromY = u.toY;
        u.toX = x;
        u.toY = y;
        u.hp = hurtById.has(nid) ? (hurtById.get(nid) as number) : u.maxHp;
        u.moving = Math.abs(x - u.fromX) + Math.abs(y - u.fromY) > 1.5;
      } else {
        const s = stat.get(nid);
        const maxHp = s ? s[3] : 1;
        this.units.set(nid, {
          kind: s ? s[1] : 0,
          faction: s ? s[2] : RED,
          x,
          y,
          fromX: x,
          fromY: y,
          toX: x,
          toY: y,
          hp: hurtById.has(nid) ? (hurtById.get(nid) as number) : maxHp,
          maxHp,
          level: s ? s[4] : 1,
          walkP: Math.random() * TAU,
          moving: false,
        });
      }
    }
    for (const nid of this.units.keys()) {
      if (!seenU.has(nid)) this.units.delete(nid);
    }

    const seenB = new Set<number>();
    for (const r of buildings) {
      const nid = r[0];
      const row = flipped ? GRID_H - 1 - r[4] : r[4];
      seenB.add(nid);
      const b = this.buildings.get(nid);
      if (b) {
        b.hp = r[5];
        b.maxHp = r[6];
        b.prog = (r[7] ?? 100) / 100;
      } else {
        this.buildings.set(nid, {
          type: BUILDING_TYPES[r[1]],
          faction: r[2],
          x: r[3] * 40 + 20,
          y: row * 40 + 20,
          col: r[3],
          row,
          hp: r[5],
          maxHp: r[6],
          prog: (r[7] ?? 100) / 100,
          t: Math.random() * 10,
        });
      }
    }
    for (const nid of this.buildings.keys()) {
      if (!seenB.has(nid)) this.buildings.delete(nid);
    }
  }

  update(delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.clock += dt;
    // Interpolate on a clock running INTERP_DELAY in the past, between the two
    // latest snapshots' arrival times. Clamped, so a late snapshot just holds
    // the last position instead of snapping/overshooting.
    const span = this.t1 - this.t0;
    const a = span > 0 ? clamp((this.clock - INTERP_DELAY - this.t0) / span, 0, 1) : 1;
    for (const u of this.units.values()) {
      u.x = u.fromX + (u.toX - u.fromX) * a;
      u.y = u.fromY + (u.toY - u.fromY) * a;
      if (u.moving || u.kind === 2) u.walkP += dt * 11; // l'hélico anime toujours son rotor
    }
    for (const b of this.buildings.values()) {
      if (b.prog < 1) b.t += dt;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);

    // In a large swarm, drop the cheapest-but-numerous per-unit extras
    // (ground shadow + level pips) to keep the guest's frame budget.
    const lod = this.units.size > 180;

    for (const b of this.buildings.values()) {
      const size = BUILDING_SIZE[b.type];
      drawBuildingBody(ctx, b.type, b.faction, b.x, b.y, b.prog, b.t);
      if (b.prog >= 1 && b.hp < b.maxHp) {
        const w = size * 0.85;
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(b.x - w / 2, b.y - size * 0.62, w, 4);
        ctx.fillStyle = b.hp / b.maxHp > 0.4 ? "#5dde6a" : "#ff5b4d";
        ctx.fillRect(b.x - w / 2, b.y - size * 0.62, w * clamp(b.hp / b.maxHp, 0, 1), 4);
      }
    }

    for (const u of this.units.values()) {
      if (u.kind === 2) {
        drawHeli(ctx, u.faction, u.x, u.y, u.walkP / 11);
        if (u.hp < u.maxHp) {
          const w = 26;
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(u.x - w / 2, u.y - 26, w, 3);
          ctx.fillStyle = u.faction === BLUE ? "#5dde6a" : "#ffb13d";
          ctx.fillRect(u.x - w / 2, u.y - 26, w * clamp(u.hp / u.maxHp, 0, 1), 3);
        }
        continue;
      }
      const size = u.kind === 1 ? 36 : 26;
      if (!lod) {
        ctx.fillStyle = "rgba(0,0,0,0.22)";
        ctx.beginPath();
        ctx.ellipse(u.x, u.y + size * 0.34, size * 0.3, size * 0.13, 0, 0, TAU);
        ctx.fill();
      }
      const bob = u.moving ? Math.sin(u.walkP) * 1.6 : 0;
      const spr =
        u.kind === 1
          ? u.faction === BLUE
            ? SPR.B_TANK
            : SPR.R_TANK
          : u.faction === BLUE
            ? SPR.B_SOLDIER
            : SPR.R_SOLDIER;
      drawSprite(ctx, spr, u.x, u.y + bob, size);
      if (!lod) drawLevelPips(ctx, u.level, u.x, u.y - size * 0.72);
      if (u.hp < u.maxHp) {
        const w = size * 0.8;
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(u.x - w / 2, u.y - size * 0.62, w, 3);
        ctx.fillStyle = u.faction === BLUE ? "#5dde6a" : "#ffb13d";
        ctx.fillRect(u.x - w / 2, u.y - size * 0.62, w * clamp(u.hp / u.maxHp, 0, 1), 3);
      }
    }
  }
}
