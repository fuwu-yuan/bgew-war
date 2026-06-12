import { Howler } from "howler";

/**
 * Global sound mute, persisted across sessions. Howler.mute() silences every
 * Howl at once — current music, SFX and any sound played afterwards — so a
 * single toggle covers the whole game.
 */
const KEY = "bgew-war.muted";

let muted = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();

export function isMuted(): boolean {
  return muted;
}

/** Re-assert the stored state on the Howler bus (call once at startup). */
export function applyMute(): void {
  Howler.mute(muted);
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(KEY, value ? "1" : "0");
  } catch {
    /* private mode: keep it in memory only */
  }
  Howler.mute(muted);
}

/** Flip mute and return the new state. */
export function toggleMute(): boolean {
  setMuted(!muted);
  return muted;
}

/** Speaker glyph in a round button — green/gold when on, red slash when muted. */
export function drawMuteIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, isMutedNow: boolean): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Button disc
  ctx.beginPath();
  ctx.arc(cx, cy, s, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(8, 20, 38, 0.72)";
  ctx.fill();
  ctx.strokeStyle = "rgba(140, 190, 235, 0.7)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const col = isMutedNow ? "#ff8b7a" : "#ffe27a";
  const bx = cx - s * 0.5;

  // Speaker body (magnet + cone)
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(bx, cy - 3);
  ctx.lineTo(bx, cy + 3);
  ctx.lineTo(bx + s * 0.3, cy + 3);
  ctx.lineTo(bx + s * 0.6, cy + s * 0.42);
  ctx.lineTo(bx + s * 0.6, cy - s * 0.42);
  ctx.lineTo(bx + s * 0.3, cy - 3);
  ctx.closePath();
  ctx.fill();

  if (isMutedNow) {
    ctx.strokeStyle = "#ff5a50";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.55, cy - s * 0.55);
    ctx.lineTo(cx + s * 0.62, cy + s * 0.62);
    ctx.stroke();
  } else {
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(cx + s * 0.15, cy, s * 0.45, -Math.PI / 4, Math.PI / 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + s * 0.15, cy, s * 0.72, -Math.PI / 4, Math.PI / 4);
    ctx.stroke();
  }
  ctx.restore();
}
