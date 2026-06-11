import { Entity } from "@fuwu-yuan/bgew";
import { BLUE, MAP_H, VIEW_W } from "../globals";
import { clamp, TAU } from "../utils";
import { drawSprite, SPR } from "../sprites";
import { drawLevelPips } from "./units";
import { BUILDING_SIZE, BUILDING_SPRITE, BUILDING_TYPES, BuildingType } from "./buildings";

interface RUnit {
  kind: number; // 0 soldier, 1 tank
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

  applySnapshot(units: number[][], buildings: number[][]): void {
    const seenU = new Set<number>();
    for (const [nid, kind, faction, x, y, hp, maxHp, level] of units) {
      seenU.add(nid);
      const u = this.units.get(nid);
      if (u) {
        u.fromX = u.x;
        u.fromY = u.y;
        u.toX = x;
        u.toY = y;
        u.hp = hp;
        u.maxHp = maxHp;
        u.moving = Math.abs(x - u.fromX) + Math.abs(y - u.fromY) > 1.5;
      } else {
        this.units.set(nid, {
          kind,
          faction,
          x,
          y,
          fromX: x,
          fromY: y,
          toX: x,
          toY: y,
          hp,
          maxHp,
          level,
          walkP: Math.random() * TAU,
          moving: false,
        });
      }
    }
    for (const nid of this.units.keys()) {
      if (!seenU.has(nid)) this.units.delete(nid);
    }

    const seenB = new Set<number>();
    for (const [nid, typeCode, faction, col, row, hp, maxHp] of buildings) {
      seenB.add(nid);
      const b = this.buildings.get(nid);
      if (b) {
        b.hp = hp;
        b.maxHp = maxHp;
      } else {
        this.buildings.set(nid, {
          type: BUILDING_TYPES[typeCode],
          faction,
          x: col * 40 + 20,
          y: row * 40 + 20,
          col,
          row,
          hp,
          maxHp,
        });
      }
    }
    for (const nid of this.buildings.keys()) {
      if (!seenB.has(nid)) this.buildings.delete(nid);
    }

    this.lerpT = 0;
  }

  update(delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.lerpT = Math.min(1, this.lerpT + dt / LERP_TIME);
    for (const u of this.units.values()) {
      u.x = u.fromX + (u.toX - u.fromX) * this.lerpT;
      u.y = u.fromY + (u.toY - u.fromY) * this.lerpT;
      if (u.moving) u.walkP += dt * 11;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);

    for (const b of this.buildings.values()) {
      const size = BUILDING_SIZE[b.type];
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.beginPath();
      ctx.ellipse(b.x, b.y + size * 0.36, size * 0.4, size * 0.15, 0, 0, TAU);
      ctx.fill();
      drawSprite(ctx, BUILDING_SPRITE[b.type][b.faction === BLUE ? 1 : 0], b.x, b.y, size);
      if (b.type === "hq") {
        drawSprite(ctx, b.faction === BLUE ? SPR.B_FLAG : SPR.R_FLAG, b.x + size * 0.48, b.y - size * 0.38, 24);
      }
      if (b.hp < b.maxHp) {
        const w = size * 0.85;
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(b.x - w / 2, b.y - size * 0.62, w, 4);
        ctx.fillStyle = b.hp / b.maxHp > 0.4 ? "#5dde6a" : "#ff5b4d";
        ctx.fillRect(b.x - w / 2, b.y - size * 0.62, w * clamp(b.hp / b.maxHp, 0, 1), 4);
      }
    }

    for (const u of this.units.values()) {
      const size = u.kind === 1 ? 36 : 26;
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      ctx.ellipse(u.x, u.y + size * 0.34, size * 0.3, size * 0.13, 0, 0, TAU);
      ctx.fill();
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
      drawLevelPips(ctx, u.level, u.x, u.y - size * 0.72);
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
