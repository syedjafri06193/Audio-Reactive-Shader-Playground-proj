import { describe, expect, it } from "vitest";

import { ResolutionScaler } from "../../src/gl/scaler.js";

/** Feed n frames of the same duration and return the last decision. */
function feed(scaler: ResolutionScaler, ms: number, frames: number) {
  let last = scaler.push(ms);
  for (let i = 1; i < frames; i++) last = scaler.push(ms);
  return last;
}

describe("ResolutionScaler", () => {
  it("starts at full resolution and stays there while the budget is met", () => {
    const s = new ResolutionScaler({ windowFrames: 10, settleFrames: 0 });
    expect(s.current).toBe(1);
    feed(s, 13, 40);
    expect(s.current).toBe(1);
  });

  it("does not decide anything before a full window", () => {
    const s = new ResolutionScaler({ windowFrames: 30 });
    for (let i = 0; i < 29; i++) {
      const d = s.push(50);
      expect(d.changed).toBe(false);
      expect(d.p90).toBeNull();
      expect(d.reason).toBe("measuring");
    }
    expect(s.push(50).changed).toBe(true);
  });

  it("drops resolution when frames run over budget", () => {
    const s = new ResolutionScaler({ windowFrames: 10, settleFrames: 0 });
    const d = feed(s, 30, 10);
    expect(d.changed).toBe(true);
    expect(d.reason).toBe("over-budget");
    expect(d.scale).toBeLessThan(1);
    expect(s.current).toBeLessThan(1);
  });

  it("recovers resolution when there is headroom", () => {
    const s = new ResolutionScaler({ windowFrames: 10, settleFrames: 0 });
    feed(s, 30, 10);
    const dropped = s.current;

    const d = feed(s, 5, 10);
    expect(d.reason).toBe("headroom");
    expect(d.scale).toBeGreaterThan(dropped);
  });

  it("drops faster than it recovers", () => {
    // The asymmetry is the point. Rendering slightly soft for an extra
    // second is invisible; oscillating between two scales is not.
    const s = new ResolutionScaler({ windowFrames: 10, settleFrames: 0 });

    feed(s, 30, 10);
    const afterOneDrop = 1 - s.current;

    s.reset();
    feed(s, 30, 10);
    const dropped = s.current;
    feed(s, 5, 10);
    const afterOneRecovery = s.current - dropped;

    expect(afterOneDrop).toBeGreaterThan(afterOneRecovery * 2);
  });

  it("uses p90 rather than the mean, so a stutter is not averaged away", () => {
    // Nine frames at 8 ms and one at 60 ms average to 13.2 ms — comfortably
    // inside a 16.7 ms budget — while what the viewer sees is a visible
    // hitch every tenth frame.
    const s = new ResolutionScaler({ windowFrames: 10, settleFrames: 0 });
    for (let i = 0; i < 9; i++) s.push(8);
    const d = s.push(60);

    expect(d.changed).toBe(true);
    expect(d.reason).toBe("over-budget");

    const mean = (9 * 8 + 60) / 10;
    expect(mean).toBeLessThan(16.7); // the mean would have said "fine"
    expect(d.p90!).toBeGreaterThan(16.7);
  });

  it("holds steady in the dead band instead of flipping every window", () => {
    // A shader sitting between "comfortable" and "target" is exactly where
    // a single-threshold scaler oscillates forever.
    const s = new ResolutionScaler({
      windowFrames: 10,
      settleFrames: 0,
      targetMs: 16.7,
      comfortableMs: 11,
    });

    let changes = 0;
    for (let w = 0; w < 20; w++) {
      const d = feed(s, 14, 10);
      if (d.changed) changes++;
      expect(d.reason).toBe("steady");
    }
    expect(changes).toBe(0);
    expect(s.current).toBe(1);
  });

  it("does not oscillate on a load that sits right at the target", () => {
    const s = new ResolutionScaler({ windowFrames: 10, settleFrames: 3 });
    const scales: number[] = [];
    for (let w = 0; w < 30; w++) {
      // Slightly over, then slightly under — the pathological input.
      feed(s, w % 2 === 0 ? 18 : 15, 14);
      scales.push(s.current);
    }
    // It should settle downward and stop, not ping-pong.
    const lastTen = scales.slice(-10);
    expect(new Set(lastTen).size).toBeLessThanOrEqual(2);
  });

  it("ignores the ~1 Hz frames a hidden tab produces", () => {
    // A backgrounded tab throttles rAF to about 1 Hz while the audio keeps
    // running. Those are not a rendering problem, and feeding them in
    // would pin the scale to the floor by the time the user came back.
    const s = new ResolutionScaler({ windowFrames: 10, settleFrames: 0 });
    for (let i = 0; i < 50; i++) {
      const d = s.push(1000);
      expect(d.changed).toBe(false);
      expect(d.reason).toBe("measuring");
    }
    expect(s.current).toBe(1);
  });

  it("ignores NaN, zero and negative durations", () => {
    const s = new ResolutionScaler({ windowFrames: 5, settleFrames: 0 });
    for (const bad of [NaN, Infinity, 0, -5]) {
      expect(s.push(bad).changed).toBe(false);
    }
    expect(s.current).toBe(1);
  });

  it("ignores frames while settling after a change", () => {
    // Reallocating framebuffers costs a frame or two. Measuring those would
    // trigger another drop immediately — a loop that walks to the floor.
    const s = new ResolutionScaler({ windowFrames: 5, settleFrames: 10 });
    expect(feed(s, 40, 5).changed).toBe(true);

    for (let i = 0; i < 10; i++) {
      const d = s.push(120); // the reallocation spike
      expect(d.reason).toBe("settling");
      expect(d.changed).toBe(false);
    }
  });

  it("never goes below the floor or above the ceiling", () => {
    const s = new ResolutionScaler({ windowFrames: 5, settleFrames: 0, minScale: 0.4 });
    for (let w = 0; w < 100; w++) feed(s, 200 > 200 ? 1 : 150, 5);
    expect(s.current).toBeGreaterThanOrEqual(0.4);

    for (let w = 0; w < 200; w++) feed(s, 1, 5);
    expect(s.current).toBeLessThanOrEqual(1);
  });

  it("stops reporting changes once it is pinned at the floor", () => {
    // Otherwise the caller reallocates framebuffers to the same size every
    // window, which is itself a frame-time cost.
    const s = new ResolutionScaler({ windowFrames: 5, settleFrames: 0, minScale: 0.5 });
    for (let w = 0; w < 30; w++) feed(s, 150, 5);
    expect(s.current).toBeCloseTo(0.5, 6);

    const d = feed(s, 150, 5);
    expect(d.changed).toBe(false);
    expect(d.reason).toBe("steady");
  });
});

describe("ResolutionScaler.sizeFor", () => {
  it("multiplies css size by scale and device pixel ratio", () => {
    const s = new ResolutionScaler();
    expect(s.sizeFor(800, 600, 1)).toEqual({ width: 800, height: 600 });
    expect(s.sizeFor(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
  });

  it("always returns even dimensions", () => {
    // Odd framebuffer dimensions break half-pixel offsets in blur and
    // feedback passes, and the resulting one-pixel-per-frame drift is very
    // hard to trace back to a rounding choice here.
    const s = new ResolutionScaler({ minScale: 0.1 });
    for (const scale of [0.37, 0.5, 0.63, 0.81, 1]) {
      s.set(scale);
      for (const [w, h] of [
        [801, 601],
        [1337, 999],
        [375, 812],
      ]) {
        const size = s.sizeFor(w, h, 1);
        expect(size.width % 2, `${scale} ${w}`).toBe(0);
        expect(size.height % 2, `${scale} ${h}`).toBe(0);
      }
    }
  });

  it("never returns a zero dimension", () => {
    // A 0×0 framebuffer is an invalid-value GL error, and a 1-pixel window
    // during a drag is entirely normal.
    const s = new ResolutionScaler({ minScale: 0.1 });
    s.set(0.1);
    const size = s.sizeFor(1, 1, 1);
    expect(size.width).toBeGreaterThanOrEqual(2);
    expect(size.height).toBeGreaterThanOrEqual(2);
  });
});

describe("ResolutionScaler.set", () => {
  it("pins the scale and clamps it to the legal range", () => {
    const s = new ResolutionScaler({ minScale: 0.5 });
    s.set(0.75);
    expect(s.current).toBe(0.75);
    s.set(0.1);
    expect(s.current).toBe(0.5);
    s.set(4);
    expect(s.current).toBe(1);
  });

  it("restarts measurement so a stale window cannot immediately override it", () => {
    const s = new ResolutionScaler({ windowFrames: 10, settleFrames: 0 });
    for (let i = 0; i < 9; i++) s.push(100); // nearly a full over-budget window
    s.set(0.6);
    expect(s.push(100).changed).toBe(false);
    expect(s.current).toBe(0.6);
  });
});
