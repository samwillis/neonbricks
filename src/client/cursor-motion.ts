import { MathUtils, Vector3 } from "three";

// A critically damped spring keeps velocity continuous when a new packet
// arrives. Its response follows the observed cadence instead of stopping
// between sparsely delivered cursor samples.
export class CursorMotion {
  readonly position: Vector3;
  readonly velocity = new Vector3();
  private readonly target: Vector3;
  private cadence = 0.25;
  private lastArrival: number | null = null;

  constructor(point: Vector3) {
    this.position = point.clone();
    this.target = point.clone();
  }

  receive(point: Vector3, arrivedAt: number) {
    if (this.target.equals(point)) {
      // Stationary presence refreshes do not describe a movement cadence.
      this.lastArrival = null;
      return;
    }
    if (this.lastArrival !== null) {
      const gap = (arrivedAt - this.lastArrival) / 1000;
      if (gap >= 0.08 && gap < 1.2)
        this.cadence = MathUtils.lerp(
          this.cadence,
          MathUtils.clamp(gap, 0.12, 0.65),
          0.4,
        );
    }
    this.lastArrival = arrivedAt;
    this.target.copy(point);
  }

  advance(delta: number) {
    if (delta <= 0) return;
    if (delta > 0.5) {
      // Resume at the current target after a backgrounded frame.
      this.position.copy(this.target);
      this.velocity.set(0, 0, 0);
      return;
    }
    const omega = 2 / MathUtils.clamp(this.cadence * 1.1, 0.18, 0.6);
    const decay = Math.exp(-omega * delta);
    for (const axis of ["x", "y", "z"] as const) {
      const offset = this.position[axis] - this.target[axis];
      const rate = this.velocity[axis] + omega * offset;
      const nextOffset = (offset + rate * delta) * decay;
      this.velocity[axis] =
        (this.velocity[axis] - omega * rate * delta) * decay;
      this.position[axis] = this.target[axis] + nextOffset;
      // Stop at the actual surface point rather than overshooting it.
      if (offset * nextOffset < 0) {
        this.position[axis] = this.target[axis];
        this.velocity[axis] = 0;
      }
    }
  }
}
