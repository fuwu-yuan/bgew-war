import { Entity } from "@fuwu-yuan/bgew";
import { BLUE, COLORS, Faction, GRID_H, GRID_W, MAP_H, RED, TILE, VIEW_W } from "../globals";
import { clamp, rand, randInt, TAU } from "../utils";
import { drawSprite, SPR } from "../sprites";

interface Decor {
  i: number;
  spr: number;
}

export interface MapInitData {
  terrain: number[];
  owner: number[];
  decors: number[][];
  chests: number[];
}

/** Mirror a tile index vertically (row r → GRID_H-1-r). */
export function flipTileIndex(i: number): number {
  return (GRID_H - 1 - Math.floor(i / GRID_W)) * GRID_W + (i % GRID_W);
}

/**
 * Vertical mirror of a full map payload — the multiplayer guest (red) sees
 * the island upside down so their army sits at the bottom of the screen.
 */
export function flipMapData(d: MapInitData): MapInitData {
  const flipGrid = (src: number[]) => {
    const out = new Array<number>(src.length);
    for (let i = 0; i < src.length; i++) out[flipTileIndex(i)] = src[i];
    return out;
  };
  return {
    terrain: flipGrid(d.terrain),
    owner: flipGrid(d.owner),
    decors: d.decors.map(([i, spr]) => [flipTileIndex(i), spr]),
    chests: d.chests.map(flipTileIndex),
  };
}

/**
 * The whole island as ONE entity (never one entity per tile): terrain mask,
 * per-tile ownership checkerboard, cliffs + sand rim, animated ocean,
 * conquest flashes, decor sprites and gold chests.
 */
export class TileMap extends Entity {
  public terrain = new Uint8Array(GRID_W * GRID_H); // 0 water, 1 land
  public owner = new Uint8Array(GRID_W * GRID_H); // 0 none, RED, BLUE
  private flash = new Float32Array(GRID_W * GRID_H);
  private decors: Decor[] = [];
  private chests = new Set<number>();
  private waveT = 0;
  private sparkles: { x: number; y: number; p: number }[] = [];
  /** Tiles whose owner changed since the last flushDirty() (multiplayer) */
  private dirty = new Set<number>();

  constructor() {
    super(0, 0, VIEW_W, MAP_H);
    this.disabled = true;
    this.generate();
  }

  /* ---------------- grid helpers ---------------- */

  idx(c: number, r: number): number {
    return r * GRID_W + c;
  }

  inBounds(c: number, r: number): boolean {
    return c >= 0 && c < GRID_W && r >= 0 && r < GRID_H;
  }

  isLand(c: number, r: number): boolean {
    return this.inBounds(c, r) && this.terrain[this.idx(c, r)] === 1;
  }

  isLandPx(x: number, y: number): boolean {
    return this.isLand(Math.floor(x / TILE), Math.floor(y / TILE));
  }

  ownerAtPx(x: number, y: number): number {
    const c = Math.floor(x / TILE);
    const r = Math.floor(y / TILE);
    return this.inBounds(c, r) ? this.owner[this.idx(c, r)] : 0;
  }

  tileCenter(c: number, r: number): { x: number; y: number } {
    return { x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 };
  }

  /** Convert the tile under (x, y) to `f`. Null if nothing changed. */
  convertAtPx(x: number, y: number, f: Faction): { chest: number } | null {
    const c = Math.floor(x / TILE);
    const r = Math.floor(y / TILE);
    if (!this.isLand(c, r)) return null;
    const i = this.idx(c, r);
    if (this.owner[i] === f) return null;
    this.owner[i] = f;
    this.flash[i] = 1;
    this.dirty.add(i);
    if (this.chests.has(i)) {
      this.chests.delete(i);
      return { chest: 25 };
    }
    return { chest: 0 };
  }

  /** Owner changes since the last call, as [index, owner] pairs. */
  flushDirty(): number[][] {
    const out: number[][] = [];
    for (const i of this.dirty) out.push([i, this.owner[i]]);
    this.dirty.clear();
    return out;
  }

  /** Apply a remote owner change (guest side) — flashes like a conquest. */
  setOwner(i: number, owner: number, flash = true): void {
    if (i < 0 || i >= this.owner.length || this.owner[i] === owner) return;
    this.owner[i] = owner;
    if (flash) this.flash[i] = 1;
    this.chests.delete(i);
  }

  /** Full state for the guest (sent once by the host). */
  getInitData(): MapInitData {
    return {
      terrain: Array.from(this.terrain),
      owner: Array.from(this.owner),
      decors: this.decors.map((d) => [d.i, d.spr]),
      chests: Array.from(this.chests),
    };
  }

  /** Replace the whole map with the host's (guest side). */
  applyInit(data: MapInitData): void {
    this.terrain = Uint8Array.from(data.terrain);
    this.owner = Uint8Array.from(data.owner);
    this.decors = data.decors.map(([i, spr]) => ({ i, spr }));
    this.chests = new Set(data.chests);
    this.flash.fill(0);
    this.dirty.clear();
  }

  /** Force a tile to be land and owned (under initial buildings). */
  claim(c: number, r: number, f: Faction): void {
    if (!this.inBounds(c, r)) return;
    const i = this.idx(c, r);
    this.terrain[i] = 1;
    this.owner[i] = f;
    this.dirty.add(i);
    this.decors = this.decors.filter((d) => d.i !== i);
    this.chests.delete(i);
  }

  hasDecor(i: number): boolean {
    return this.chests.has(i) || this.decors.some((d) => d.i === i);
  }

  /** Territory share of `f` among owned land tiles (0..1). */
  share(f: Faction): number {
    let mine = 0;
    let all = 0;
    for (let i = 0; i < this.owner.length; i++) {
      if (this.owner[i] !== 0) {
        all++;
        if (this.owner[i] === f) mine++;
      }
    }
    return all > 0 ? mine / all : 0.5;
  }

  /**
   * Northernmost row held by BLUE in a column (blue pushes up).
   * Returns GRID_H if blue holds nothing there.
   */
  blueFrontRow(c: number): number {
    for (let r = 0; r < GRID_H; r++) {
      if (this.owner[this.idx(c, r)] === BLUE) return r;
    }
    return GRID_H;
  }

  /**
   * First row (from the top) owned by `f` — the front of an army that
   * pushes upward. On the guest's mirrored view, red pushes up too, so
   * this works for "my front" on every screen.
   */
  frontRowFromTop(f: Faction, c: number): number {
    for (let r = 0; r < GRID_H; r++) {
      if (this.owner[this.idx(c, r)] === f) return r;
    }
    return GRID_H;
  }

  /** Front row of `f` in a column: where its troops are headed. */
  frontRowOf(f: Faction, c: number): number {
    if (f === BLUE) return this.blueFrontRow(c);
    for (let r = GRID_H - 1; r >= 0; r--) {
      if (this.owner[this.idx(c, r)] === RED) return r;
    }
    return 0;
  }

  /* ---------------- generation ---------------- */

  private generate(): void {
    const ph1 = rand(0, TAU);
    const ph2 = rand(0, TAU);
    this.terrain.fill(1);

    // Irregular coastline: noisy bites on every edge, deeper in the corners
    for (let c = 0; c < GRID_W; c++) {
      const top = clamp(Math.round(0.7 + Math.sin(c * 1.3 + ph1) * 0.9 + rand(-0.4, 0.4)), 0, 2);
      const bot = clamp(Math.round(0.7 + Math.sin(c * 1.7 + ph2) * 0.9 + rand(-0.4, 0.4)), 0, 2);
      for (let r = 0; r < top; r++) this.terrain[this.idx(c, r)] = 0;
      for (let r = 0; r < bot; r++) this.terrain[this.idx(c, GRID_H - 1 - r)] = 0;
    }
    for (let r = 0; r < GRID_H; r++) {
      const left = clamp(Math.round(0.6 + Math.sin(r * 1.1 + ph2) * 0.8 + rand(-0.4, 0.4)), 0, 2);
      const right = clamp(Math.round(0.6 + Math.sin(r * 0.9 + ph1) * 0.8 + rand(-0.4, 0.4)), 0, 2);
      for (let c = 0; c < left; c++) this.terrain[this.idx(c, r)] = 0;
      for (let c = 0; c < right; c++) this.terrain[this.idx(GRID_W - 1 - c, r)] = 0;
    }
    for (const [cc, cr] of [
      [0, 0],
      [GRID_W - 1, 0],
      [0, GRID_H - 1],
      [GRID_W - 1, GRID_H - 1],
    ]) {
      this.terrain[this.idx(cc, cr)] = 0;
      if (Math.random() < 0.7) this.terrain[this.idx(Math.abs(cc - 1), cr)] = 0;
      if (Math.random() < 0.7) this.terrain[this.idx(cc, Math.abs(cr - 1))] = 0;
    }

    // Initial front: wavy split around the middle row
    const ph3 = rand(0, TAU);
    for (let c = 0; c < GRID_W; c++) {
      const split = Math.round(GRID_H / 2 + Math.sin(c * 0.75 + ph3) * 1.6 + rand(-0.6, 0.6));
      for (let r = 0; r < GRID_H; r++) {
        const i = this.idx(c, r);
        this.owner[i] = this.terrain[i] === 1 ? (r < split ? RED : BLUE) : 0;
      }
    }

    // Decor: trees, rocks, tank traps — none in the middle band (chests live there)
    const sprites = [SPR.TREE, SPR.TREE, SPR.TREES, SPR.MOUNTAIN, SPR.HEDGEHOG];
    for (let n = 0; n < 30; n++) {
      const c = randInt(0, GRID_W - 1);
      const r = randInt(0, GRID_H - 1);
      const i = this.idx(c, r);
      if (this.terrain[i] !== 1 || r >= 10 && r <= 13 || this.hasDecor(i)) continue;
      this.decors.push({ i, spr: sprites[randInt(0, sprites.length - 1)] });
    }

    // Gold chests on the contested middle band
    for (let n = 0; n < 6; n++) {
      const c = randInt(1, GRID_W - 2);
      const r = randInt(10, 13);
      const i = this.idx(c, r);
      if (this.terrain[i] === 1 && !this.hasDecor(i)) this.chests.add(i);
    }

    // Ocean sparkles (fixed points, pulsing alpha)
    for (let n = 0; n < 40; n++) {
      this.sparkles.push({ x: rand(0, VIEW_W), y: rand(0, MAP_H), p: rand(0, TAU) });
    }
  }

  /* ---------------- loop ---------------- */

  update(delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.waveT += dt;
    for (let i = 0; i < this.flash.length; i++) {
      if (this.flash[i] > 0) this.flash[i] = Math.max(0, this.flash[i] - dt * 3);
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    super.draw(ctx);

    /* Ocean */
    const grad = ctx.createLinearGradient(0, 0, 0, MAP_H);
    grad.addColorStop(0, COLORS.oceanDeep);
    grad.addColorStop(0.5, COLORS.ocean);
    grad.addColorStop(1, COLORS.oceanDeep);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VIEW_W, MAP_H);

    ctx.fillStyle = "rgba(255,255,255,0.05)";
    for (let k = 0; k < 4; k++) {
      const y = ((this.waveT * 14 + k * MAP_H / 4) % (MAP_H + 60)) - 30;
      ctx.fillRect(0, y, VIEW_W, 7);
    }
    for (const s of this.sparkles) {
      const a = 0.18 + 0.18 * Math.sin(this.waveT * 2.2 + s.p);
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.fillRect(s.x, s.y, 3, 3);
    }

    /* Shallow halo around the island */
    ctx.fillStyle = "rgba(140, 200, 240, 0.35)";
    for (let r = 0; r < GRID_H; r++) {
      for (let c = 0; c < GRID_W; c++) {
        if (this.terrain[this.idx(c, r)] === 1) continue;
        let nearLand = false;
        for (let dr = -1; dr <= 1 && !nearLand; dr++) {
          for (let dc = -1; dc <= 1 && !nearLand; dc++) {
            if (this.isLand(c + dc, r + dr)) nearLand = true;
          }
        }
        if (nearLand) ctx.fillRect(c * TILE - 4, r * TILE - 4, TILE + 8, TILE + 8);
      }
    }

    /* Cliffs first (under the plateau), then tiles, sand rim, flash */
    for (let r = 0; r < GRID_H; r++) {
      for (let c = 0; c < GRID_W; c++) {
        const i = this.idx(c, r);
        if (this.terrain[i] !== 1) continue;
        const x = c * TILE;
        const y = r * TILE;
        if (!this.isLand(c, r + 1)) {
          ctx.fillStyle = COLORS.cliff;
          ctx.fillRect(x, y + TILE, TILE, 11);
          ctx.fillStyle = COLORS.cliffDark;
          ctx.fillRect(x, y + TILE + 11, TILE, 4);
        }
      }
    }

    for (let r = 0; r < GRID_H; r++) {
      for (let c = 0; c < GRID_W; c++) {
        const i = this.idx(c, r);
        if (this.terrain[i] !== 1) continue;
        const x = c * TILE;
        const y = r * TILE;
        const own = this.owner[i];
        const even = (c + r) % 2 === 0;
        ctx.fillStyle =
          own === RED
            ? even
              ? COLORS.redTileA
              : COLORS.redTileB
            : even
              ? COLORS.blueTileA
              : COLORS.blueTileB;
        ctx.fillRect(x, y, TILE, TILE);

        // Sand rim on every side facing the sea
        ctx.fillStyle = COLORS.sand;
        if (!this.isLand(c, r - 1)) ctx.fillRect(x, y, TILE, 5);
        if (!this.isLand(c, r + 1)) ctx.fillRect(x, y + TILE - 5, TILE, 5);
        if (!this.isLand(c - 1, r)) ctx.fillRect(x, y, 5, TILE);
        if (!this.isLand(c + 1, r)) ctx.fillRect(x + TILE - 5, y, 5, TILE);

        const fl = this.flash[i];
        if (fl > 0) {
          ctx.fillStyle = `rgba(255,255,255,${(fl * 0.65).toFixed(3)})`;
          ctx.fillRect(x, y, TILE, TILE);
        }
      }
    }

    /* Decor + chests */
    for (const d of this.decors) {
      const c = d.i % GRID_W;
      const r = Math.floor(d.i / GRID_W);
      drawSprite(ctx, d.spr, c * TILE + TILE / 2, r * TILE + TILE / 2, 30);
    }
    for (const i of this.chests) {
      const c = i % GRID_W;
      const r = Math.floor(i / GRID_W);
      const bob = Math.sin(this.waveT * 3 + i) * 2;
      drawSprite(ctx, SPR.GOLD, c * TILE + TILE / 2, r * TILE + TILE / 2 + bob, 26);
    }
  }
}
