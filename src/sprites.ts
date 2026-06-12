/**
 * Kenney "Tiny Battle" packed tilesheet (CC0) — 18 columns of 16×16 tiles.
 * https://kenney.nl/assets/tiny-battle
 */
const SHEET_COLS = 18;
const TILE_PX = 16;

/** Tile indices in tilemap_packed.png (row-major, 18 per row) */
export const SPR = {
  // decor
  TREE: 94,
  TREES: 112,
  MOUNTAIN: 5,
  HEDGEHOG: 23,
  GOLD: 191,
  HEART: 195,
  RETICLE: 61,
  // blue faction
  B_SOLDIER: 142,
  B_TANK: 134,
  B_HELI: 137,
  B_HQ: 50,
  B_BARRACKS: 46,
  B_FACTORY: 47,
  B_TURRET: 49,
  B_FLAG: 52,
  // red faction
  R_SOLDIER: 160,
  R_TANK: 152,
  R_HELI: 155,
  R_HQ: 68,
  R_BARRACKS: 64,
  R_FACTORY: 65,
  R_TURRET: 67,
  R_FLAG: 70,
} as const;

let sheet: HTMLImageElement | null = null;

export function loadSprites(): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      sheet = img;
      resolve();
    };
    img.onerror = () => reject(new Error("tilemap_packed.png failed to load"));
    img.src = "assets/sprites/tilemap_packed.png";
  });
}

/** Draw tile `index` with its CENTER at (cx, cy), scaled to `size` px. */
export function drawSprite(ctx: CanvasRenderingContext2D, index: number, cx: number, cy: number, size: number): void {
  if (!sheet) return;
  const sx = (index % SHEET_COLS) * TILE_PX;
  const sy = Math.floor(index / SHEET_COLS) * TILE_PX;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sheet, sx, sy, TILE_PX, TILE_PX, cx - size / 2, cy - size / 2, size, size);
}
