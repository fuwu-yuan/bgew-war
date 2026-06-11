import { Entity } from "@fuwu-yuan/bgew";

/**
 * Base class for every gameplay entity: circular hitbox, center-based
 * coordinates and a `dead` flag consumed by the game step cleanup pass.
 */
export abstract class GameObject extends Entity {
  public dead = false;
  public radius: number;

  protected constructor(cx: number, cy: number, radius: number) {
    super(cx - radius, cy - radius, radius * 2, radius * 2);
    this.radius = radius;
    // Skip the engine's per-mouse-event hit testing: gameplay objects
    // don't listen to pointer events, and this keeps event dispatch cheap.
    this.disabled = true;
  }

  get cx(): number {
    return this.x + this.radius;
  }

  set cx(v: number) {
    this.x = v - this.radius;
  }

  get cy(): number {
    return this.y + this.radius;
  }

  set cy(v: number) {
    this.y = v - this.radius;
  }

  distTo(x: number, y: number): number {
    const dx = x - this.cx;
    const dy = y - this.cy;
    return Math.sqrt(dx * dx + dy * dy);
  }
}
