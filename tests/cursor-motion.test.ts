import { describe, it, expect } from "vitest";
import { Vector3 } from "three";
import { CursorMotion } from "../src/client/cursor-motion";

describe("remote cursor animation", () => {
  it("starts at the received surface point and preserves position and velocity across new samples", () => {
    const motion = new CursorMotion(new Vector3(2, 4, 6));
    expect(motion.position).toEqual(new Vector3(2, 4, 6));
    motion.receive(new Vector3(4, 8, 12), 200);
    motion.advance(0.1);
    const before = motion.position.clone();
    const velocity = motion.velocity.clone();
    motion.receive(new Vector3(6, 9, 15), 550);
    expect(motion.position).toEqual(before);
    expect(motion.velocity).toEqual(velocity);
    motion.advance(1 / 60);
    expect(motion.position.x).toBeGreaterThan(before.x);
  });

  it.each([200, 350, 500])(
    "keeps moving between %i ms samples instead of stopping between packets",
    (period) => {
      const motion = new CursorMotion(new Vector3());
      const speeds: number[] = [];
      // A cursor travelling one stud per second, observed at a low packet rate.
      for (let time = 0; time < 6000; time += 10) {
        if (time % period === 0)
          motion.receive(new Vector3(time / 1000, 0, 0), time);
        const before = motion.position.x;
        motion.advance(0.01);
        if (time > 2000) speeds.push((motion.position.x - before) / 0.01);
      }
      expect(Math.min(...speeds)).toBeGreaterThan(0.6);
      expect(Math.max(...speeds)).toBeLessThan(1.3);
    },
  );

  it("settles on the actual point without oscillating or overshooting after jittery delivery", () => {
    const motion = new CursorMotion(new Vector3());
    let arrival = 0;
    for (const gap of [200, 370, 190, 480, 290]) {
      arrival += gap;
      motion.receive(new Vector3(arrival / 100, 2, -3), arrival);
      for (let i = 0; i < 10; i++) motion.advance(gap / 10000);
    }
    const target = new Vector3(arrival / 100, 2, -3);
    for (let i = 0; i < 180; i++) {
      const before = motion.position.x;
      motion.advance(1 / 60);
      expect(motion.position.x).toBeGreaterThanOrEqual(before);
      expect(motion.position.x).toBeLessThanOrEqual(target.x);
    }
    expect(motion.position.distanceTo(target)).toBeLessThan(0.001);
    expect(motion.velocity.length()).toBeLessThan(0.001);
  });

  it("moves equally at different frame rates and ignores identical stationary refreshes", () => {
    const fast = new CursorMotion(new Vector3());
    const slow = new CursorMotion(new Vector3());
    for (const motion of [fast, slow])
      motion.receive(new Vector3(4, 2, -3), 100);
    for (let i = 0; i < 30; i++) {
      fast.advance(1 / 120);
      if (i === 10) fast.receive(new Vector3(4, 2, -3), 200);
    }
    for (let i = 0; i < 15; i++) slow.advance(1 / 60);
    expect(fast.position.distanceTo(slow.position)).toBeLessThan(1e-10);
    expect(fast.velocity.distanceTo(slow.velocity)).toBeLessThan(1e-10);
  });

  it("resumes at the current target after a long backgrounded frame", () => {
    const motion = new CursorMotion(new Vector3());
    const target = new Vector3(4, 2, -3);
    motion.receive(target, 200);
    motion.advance(0.1);
    motion.advance(3);
    expect(motion.position).toEqual(target);
    expect(motion.velocity.length()).toBe(0);
  });
});
