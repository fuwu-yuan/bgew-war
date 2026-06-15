import { Entity } from "@fuwu-yuan/bgew";
import { BLUE, GRID_H, MAP_H, VIEW_W } from "../globals";
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

const LERP_TIME = 0.12; // s — slightly longer than the 100 ms snapshot period

/**
 * Guest-side mirror of the host simulation: ONE entity that draws every
 * remote unit and building from the latest snapshot, interpolating unit
 * positions between snapshots. No gameplay logic lives here.
 */
export class RemoteWorld extends Entity {
  private units = new Map<number, RUnit>();
  private buildings = new Map<number, RBuilding>();
  private lerpT = 0;
  private lerpDur = LERP_TIME; // interpolation window, adapted to the real snapshot cadence
  private sinceSnap = 0;

  constructor() {
    super(0, 0, VIEW_W, MAP_H);
    this.disabled = true;
  }

  buildingAtTile(c: number, r: number): boolean {
    for (const b of this.buildings.values()) {
      if (b.col === c && b.row === r) return true;
    }
    return false;
  }

  /**
   * Ingest a host snapshot. Takes the RAW snapshot arrays plus the guest's
   * `flipped` flag and does the view conversion inline — no per-snapshot array
   * allocation (the guest used to `.map()` every unit twice per snapshot, which
   * churned the GC hard during big battles).
   */
  applySnapshot(units: number[][], buildings: number[][], flipped: boolean): void {
    const seenU = new Set<number>();
    for (const r of units) {
      const nid = r[0];
      const y = flipped ? MAP_H - r[4] : r[4];
      seenU.add(nid);
      const u = this.units.get(nid);
      if (u) {
        u.fromX = u.x;
        u.fromY = u.y;
        u.toX = r[3];
        u.toY = y;
        u.hp = r[5];
        u.maxHp = r[6];
        u.moving = Math.abs(r[3] - u.fromX) + Math.abs(y - u.fromY) > 1.5;
      } else {
        this.units.set(nid, {
          kind: r[1],
          faction: r[2],
          x: r[3],
          y,
          fromX: r[3],
          fromY: y,
          toX: r[3],
          toY: y,
          hp: r[5],
          maxHp: r[6],
          level: r[7],
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

    // Interpolate over the ACTUAL gap since the last snapshot (the host throttles
    // its snapshot rate when there are many units), so motion stays smooth.
    this.lerpDur = clamp(this.sinceSnap || LERP_TIME, 0.08, 0.3);
    this.sinceSnap = 0;
    this.lerpT = 0;
  }

  update(delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.sinceSnap += dt;
    this.lerpT = Math.min(1, this.lerpT + dt / this.lerpDur);
    for (const u of this.units.values()) {
      u.x = u.fromX + (u.toX - u.fromX) * this.lerpT;
      u.y = u.fromY + (u.toY - u.fromY) * this.lerpT;
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
