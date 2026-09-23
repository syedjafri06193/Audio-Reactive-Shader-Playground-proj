import { describe, expect, it } from "vitest";

import {
  EASINGS,
  INTERPOLATORS,
  easeInOutCubic,
  interpolate,
  lerpAngle,
  lerpAngleRadians,
  lerpColor,
  lerpFloat,
  lerpVector,
  luminance,
  parseHex,
  smoothstep,
  snap,
  toHex,
  wrapDegrees,
  type RGB,
} from "../../src/params/interpolate.js";

const RED: RGB = { r: 1, g: 0, b: 0 };
const GREEN: RGB = { r: 0, g: 1, b: 0 };
const BLUE: RGB = { r: 0, g: 0, b: 1 };
const WHITE: RGB = { r: 1, g: 1, b: 1 };
const BLACK: RGB = { r: 0, g: 0, b: 0 };

/** The naive version, kept here so the tests can compare against it. */
function lerpSRGB(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

describe("lerpAngle", () => {
  it("takes the short way round from 350° to 10°", () => {
    // The design document's own test, with one correction. It asserts the
    // midpoint is 0; the implementation returns 360. Those are the same
    // angle, and the unwrapped form is the deliberate choice (see the note
    // on lerpAngle), so the assertion is made on the circle rather than on
    // the raw number.
    expect(wrapDegrees(lerpAngle(350, 10, 0.5))).toBeCloseTo(0, 6);

    // A naive lerp gives 180 — the exact opposite side of the wheel from
    // what anyone means by this transition.
    expect(lerpFloat(350, 10, 0.5)).toBeCloseTo(180, 6);
  });

  it("hits both endpoints", () => {
    expect(lerpAngle(350, 10, 0)).toBeCloseTo(350, 6);
    expect(wrapDegrees(lerpAngle(350, 10, 1))).toBeCloseTo(10, 6);
  });

  it("stays continuous across the seam rather than jumping 360°", () => {
    // Why the result is not wrapped. Anything downstream that smooths this
    // parameter — slew filtering, a second interpolation — sees a wrapped
    // ramp jump from 359.9 to 0.1 and spins the shader most of a turn
    // backwards to catch up.
    let prev = lerpAngle(350, 10, 0);
    for (let i = 1; i <= 100; i++) {
      const v = lerpAngle(350, 10, i / 100);
      expect(Math.abs(v - prev)).toBeLessThan(1);
      prev = v;
    }
  });

  it("takes the short way in the other direction too", () => {
    expect(wrapDegrees(lerpAngle(10, 350, 0.5))).toBeCloseTo(0, 6);
  });

  it("never travels more than 180° for the full transition", () => {
    for (let a = 0; a < 360; a += 17) {
      for (let b = 0; b < 360; b += 23) {
        const travelled = Math.abs(lerpAngle(a, b, 1) - a);
        expect(travelled).toBeLessThanOrEqual(180.0000001);
      }
    }
  });

  it("handles angles outside [0, 360) without wrapping first", () => {
    // Rotation parameters accumulate. A shader left running for a minute at
    // 90°/s is at 5400°, and the +540 in the implementation is what makes
    // that work rather than producing a wild sweep.
    expect(lerpAngle(5400, 5410, 0.5)).toBeCloseTo(5405, 6);
    expect(lerpAngle(-10, 10, 0.5)).toBeCloseTo(0, 6);
    expect(lerpAngle(-350, -10, 0.5)).toBeCloseTo(-360, 6);
  });

  it("picks one direction consistently for an exact 180° opposition", () => {
    // Genuinely ambiguous; what matters is that it does not produce NaN or
    // jitter between frames.
    const mid = lerpAngle(0, 180, 0.5);
    expect(Number.isFinite(mid)).toBe(true);
    expect(Math.abs(mid)).toBeCloseTo(90, 6);
  });
});

describe("lerpAngleRadians", () => {
  it("takes the short way round near the 2π seam", () => {
    const a = (350 * Math.PI) / 180;
    const b = (10 * Math.PI) / 180;
    const mid = lerpAngleRadians(a, b, 0.5);
    expect(Math.cos(mid)).toBeCloseTo(1, 6);
    expect(Math.sin(mid)).toBeCloseTo(0, 6);
  });

  it("agrees with the degree version", () => {
    for (const [a, b] of [
      [350, 10],
      [10, 350],
      [0, 90],
      [270, 45],
    ]) {
      const deg = lerpAngle(a, b, 0.37);
      const rad = (lerpAngleRadians((a * Math.PI) / 180, (b * Math.PI) / 180, 0.37) * 180) / Math.PI;
      expect(rad).toBeCloseTo(deg, 6);
    }
  });
});

describe("lerpColor", () => {
  it("passes red→green through yellow rather than through mud", () => {
    // The design document's second test, and the whole reason this module
    // does not just lerp three floats. The sRGB midpoint of red and green is
    // (0.5, 0.5, 0) — a dark olive that appears nowhere in a natural
    // gradient between them.
    const mid = lerpColor(RED, GREEN, 0.5);
    const naive = lerpSRGB(RED, GREEN, 0.5);

    expect(luminance(mid)).toBeGreaterThan(0.35);
    expect(luminance(naive)).toBeLessThan(0.3);
    // And the improvement is not marginal.
    expect(luminance(mid)).toBeGreaterThan(luminance(naive) * 1.5);
  });

  it("keeps the midpoint of red→green recognisably yellow", () => {
    const mid = lerpColor(RED, GREEN, 0.5);
    // Yellow: red and green both high, blue low.
    expect(mid.r).toBeGreaterThan(0.6);
    expect(mid.g).toBeGreaterThan(0.6);
    expect(mid.b).toBeLessThan(0.35);
  });

  it("returns the endpoints exactly", () => {
    for (const c of [RED, GREEN, BLUE, WHITE, BLACK]) {
      const a = lerpColor(c, BLUE, 0);
      expect(a.r).toBeCloseTo(c.r, 4);
      expect(a.g).toBeCloseTo(c.g, 4);
      expect(a.b).toBeCloseTo(c.b, 4);

      const b = lerpColor(BLUE, c, 1);
      expect(b.r).toBeCloseTo(c.r, 4);
      expect(b.g).toBeCloseTo(c.g, 4);
      expect(b.b).toBeCloseTo(c.b, 4);
    }
  });

  it("never dips darker than the darker of the two endpoints", () => {
    // This is the precise statement of "not through mud", and it is a
    // property rather than a taste judgement: a blend between two colours
    // should not be darker than both of them. Measured across the ramp:
    //
    //   pair          sRGB max dip   OKLab max dip
    //   red→green     0.0650         0.0000
    //   red→blue      0.0243         0.0000
    //   blue→yellow   0.0060         0.0000
    //   blue→white    0.0000         0.0000
    const pairs: Array<[RGB, RGB]> = [
      [RED, GREEN],
      [RED, BLUE],
      [BLUE, { r: 1, g: 1, b: 0 }],
      [BLUE, WHITE],
    ];

    for (const [a, b] of pairs) {
      const floor = Math.min(luminance(a), luminance(b));
      for (let i = 1; i < 20; i++) {
        expect(luminance(lerpColor(a, b, i / 20))).toBeGreaterThanOrEqual(floor - 1e-9);
      }
    }
  });

  it("does not turn blue→yellow into a pass through grey", () => {
    // The sRGB midpoint of blue and yellow is #808080 — exactly neutral
    // grey, with no trace of either colour. A gradient built that way reads
    // as two colours with a dead spot between them.
    const naive = lerpSRGB(BLUE, { r: 1, g: 1, b: 0 }, 0.5);
    const saturationOf = (c: RGB) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);

    expect(saturationOf(naive)).toBeLessThan(0.01); // grey
    expect(saturationOf(lerpColor(BLUE, { r: 1, g: 1, b: 0 }, 0.5))).toBeGreaterThan(0.2);
  });

  it("climbs monotonically in luminance on a black→white ramp", () => {
    // A blend that doubles back is a bug regardless of colour space. Note
    // that OKLab's midpoint here is #636363, not #808080: OKLab's L is the
    // cube root of luminance for greys and is not CIE L*, so this ramp is
    // *not* evenly spaced in L* and no test here claims it is.
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const l = luminance(lerpColor(BLACK, WHITE, i / 20));
      expect(l).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = l;
    }
    expect(luminance(lerpColor(BLACK, WHITE, 0.5))).toBeCloseTo(0.125, 3);
  });

  it("never emits a component outside 0–1", () => {
    // OKLab describes colours sRGB cannot, and the round trip produces
    // out-of-range components for them. A negative uniform renders as a
    // colour nobody chose, so they are clamped.
    const saturated: RGB[] = [RED, GREEN, BLUE, { r: 0, g: 1, b: 1 }, { r: 1, g: 0, b: 1 }];
    for (const a of saturated) {
      for (const b of saturated) {
        for (let i = 0; i <= 10; i++) {
          const c = lerpColor(a, b, i / 10);
          for (const v of [c.r, c.g, c.b]) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
            expect(Number.isNaN(v)).toBe(false);
          }
        }
      }
    }
  });

  it("is symmetric: a→b at t equals b→a at 1−t", () => {
    const forward = lerpColor(RED, BLUE, 0.3);
    const backward = lerpColor(BLUE, RED, 0.7);
    expect(forward.r).toBeCloseTo(backward.r, 4);
    expect(forward.g).toBeCloseTo(backward.g, 4);
    expect(forward.b).toBeCloseTo(backward.b, 4);
  });

  it("handles a blend between identical colours", () => {
    const c = lerpColor(RED, RED, 0.5);
    expect(c.r).toBeCloseTo(1, 4);
    expect(c.g).toBeCloseTo(0, 4);
    expect(c.b).toBeCloseTo(0, 4);
  });
});

describe("snap", () => {
  it("does not invent a value between two integers", () => {
    // An iteration count of 7.3 is meaningless — the shader would floor it,
    // and the transition would look identical to snapping anyway while
    // costing a uniform upload per frame.
    expect(snap(4, 8, 0.4)).toBe(4);
    expect(snap(4, 8, 0.6)).toBe(8);
  });

  it("switches exactly at the midpoint", () => {
    expect(snap("a", "b", 0.499999)).toBe("a");
    expect(snap("a", "b", 0.5)).toBe("b");
  });

  it("works for booleans and enum strings", () => {
    expect(snap(false, true, 0.9)).toBe(true);
    expect(snap("mirror", "repeat", 0.1)).toBe("mirror");
  });
});

describe("lerpVector", () => {
  it("interpolates componentwise", () => {
    expect(lerpVector([0, 10], [10, 20], 0.5)).toEqual([5, 15]);
  });

  it("does not read past the end of the shorter vector", () => {
    // A preset saved when a parameter was a vec2 and loaded after it became
    // a vec3 would otherwise produce NaN in the third component, which in a
    // shader poisons everything downstream of it.
    const out = lerpVector([0, 0], [1, 1, 1], 0.5);
    expect(out).toHaveLength(2);
    expect(out.every(Number.isFinite)).toBe(true);
  });
});

describe("INTERPOLATORS", () => {
  it("has an entry for every parameter type", () => {
    const types = ["float", "color", "angle", "int", "bool", "enum", "vec2", "vec3"];
    for (const t of types) {
      expect(typeof INTERPOLATORS[t as keyof typeof INTERPOLATORS]).toBe("function");
    }
    expect(Object.keys(INTERPOLATORS).sort()).toEqual([...types].sort());
  });

  it("dispatches on the declared type, not on the value's shape", () => {
    // A float and an angle are both numbers. Only the declaration tells
    // them apart, which is the reason parameters carry a type at all.
    expect(interpolate("float", 350, 10, 0.5)).toBeCloseTo(180, 6);
    expect(wrapDegrees(interpolate("angle", 350, 10, 0.5) as number)).toBeCloseTo(0, 6);

    // A float and an int are both numbers too.
    expect(interpolate("float", 4, 8, 0.4)).toBeCloseTo(5.6, 6);
    expect(interpolate("int", 4, 8, 0.4)).toBe(4);
  });

  it("routes colours through the OKLab path", () => {
    const viaTable = interpolate("color", RED, GREEN, 0.5) as RGB;
    const direct = lerpColor(RED, GREEN, 0.5);
    expect(viaTable).toEqual(direct);
  });
});

describe("easing", () => {
  it("pins both endpoints for every curve", () => {
    for (const [name, fn] of Object.entries(EASINGS)) {
      expect(fn(0), name).toBeCloseTo(0, 6);
      expect(fn(1), name).toBeCloseTo(1, 6);
    }
  });

  it("is monotone for every curve", () => {
    for (const [name, fn] of Object.entries(EASINGS)) {
      let prev = -Infinity;
      for (let i = 0; i <= 50; i++) {
        const v = fn(i / 50);
        expect(v, name).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    }
  });

  it("clamps out-of-range t rather than overshooting", () => {
    // A morph driven by a clock that ran slightly past its duration should
    // settle, not spring past the target and come back.
    for (const [name, fn] of Object.entries(EASINGS)) {
      expect(fn(1.4), name).toBeCloseTo(1, 6);
      expect(fn(-0.3), name).toBeCloseTo(0, 6);
    }
  });

  it("eases in and out symmetrically about the midpoint", () => {
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
    for (const t of [0.1, 0.25, 0.4]) {
      expect(easeInOutCubic(t) + easeInOutCubic(1 - t)).toBeCloseTo(1, 6);
    }
  });

  it("starts and ends slowly, which is what makes it read as designed", () => {
    // The defining property: the first tenth of the timeline covers much
    // less than a tenth of the distance.
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
    expect(1 - easeInOutCubic(0.9)).toBeLessThan(0.1);
    expect(smoothstep(0.1)).toBeLessThan(0.1);
  });
});

describe("hex", () => {
  it("round-trips", () => {
    for (const hex of ["#ff0080", "#000000", "#ffffff", "#123456"]) {
      expect(toHex(parseHex(hex))).toBe(hex);
    }
  });

  it("expands the three-digit form", () => {
    expect(toHex(parseHex("#f08"))).toBe("#ff0088");
  });

  it("tolerates a missing hash and surrounding space", () => {
    expect(toHex(parseHex(" ff0080 "))).toBe("#ff0080");
  });

  it("throws on something that is not a colour", () => {
    expect(() => parseHex("#gggggg")).toThrow(/not a colour/);
    expect(() => parseHex("#ff00")).toThrow();
  });

  it("clamps rather than wrapping when writing out-of-range values", () => {
    expect(toHex({ r: 1.4, g: -0.2, b: 0.5 })).toBe("#ff0080");
  });
});

describe("luminance", () => {
  it("linearises rather than averaging raw sRGB", () => {
    // Mid-grey sRGB (0.5) has a relative luminance near 0.21, not 0.5.
    // Computing luminance on raw components — a common shortcut — would
    // make every assertion above about "mud" meaningless.
    expect(luminance({ r: 0.5, g: 0.5, b: 0.5 })).toBeCloseTo(0.2140, 3);
  });

  it("weights green far above blue", () => {
    expect(luminance(GREEN)).toBeGreaterThan(luminance(RED));
    expect(luminance(RED)).toBeGreaterThan(luminance(BLUE));
  });

  it("pins black and white", () => {
    expect(luminance(BLACK)).toBeCloseTo(0, 6);
    expect(luminance(WHITE)).toBeCloseTo(1, 6);
  });
});
