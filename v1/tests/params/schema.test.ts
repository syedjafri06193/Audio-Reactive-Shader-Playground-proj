import { describe, expect, it } from "vitest";

import {
  ParamSchema,
  defaultOf,
  denormalize,
  normalize,
  type ParamDecl,
} from "../../src/params/schema.js";
import type { RGB } from "../../src/params/interpolate.js";

const DECLS: ParamDecl[] = [
  { name: "uWarp", label: "Warp", type: "float", min: 0, max: 2, default: 0.5 },
  { name: "uAngle", label: "Angle", type: "angle", min: 0, max: 360, default: 0 },
  { name: "uIters", label: "Iterations", type: "int", min: 1, max: 32, default: 8 },
  { name: "uScale", label: "Scale", type: "float", min: 0.1, max: 100, default: 1, curve: "log" },
  { name: "uMix", label: "Mix", type: "float", min: 0, max: 1, default: 0.5, step: 0.1 },
  { name: "uInvert", label: "Invert", type: "bool", default: false },
  {
    name: "uMode",
    label: "Mode",
    type: "enum",
    options: ["mirror", "repeat", "clamp"],
    default: "repeat",
  },
  { name: "uTint", label: "Tint", type: "color", default: { r: 1, g: 0.5, b: 0 } },
  { name: "uOffset", label: "Offset", type: "vec2", min: -1, max: 1, default: [0, 0] },
];

const schema = new ParamSchema(DECLS);
const decl = (name: string) => schema.get(name)!;

describe("ParamSchema", () => {
  it("preserves declaration order, which is the UI's display order", () => {
    expect(schema.order.map((d) => d.name)).toEqual(DECLS.map((d) => d.name));
  });

  it("refuses a duplicate name rather than silently overwriting", () => {
    // Two declarations for one uniform means one of them is dead, and
    // which one wins depends on object key order — a bug that only shows
    // up as "that slider does nothing".
    expect(
      () =>
        new ParamSchema([
          { name: "uWarp", label: "A", type: "float", min: 0, max: 1, default: 0 },
          { name: "uWarp", label: "B", type: "float", min: 0, max: 1, default: 1 },
        ]),
    ).toThrow(/duplicate/);
  });

  it("produces every parameter at its declared default", () => {
    const d = schema.defaults();
    expect(d.uWarp).toBe(0.5);
    expect(d.uMode).toBe("repeat");
    expect(d.uInvert).toBe(false);
    expect(d.uTint).toEqual({ r: 1, g: 0.5, b: 0 });
  });

  it("hands out a fresh copy of object defaults", () => {
    // Otherwise the first caller to nudge a colour changes the default for
    // every future reset, and the bug survives until someone reloads.
    const a = schema.defaults();
    const b = schema.defaults();
    (a.uTint as RGB).r = 0;
    (a.uOffset as number[])[0] = 9;

    expect((b.uTint as RGB).r).toBe(1);
    expect((b.uOffset as number[])[0]).toBe(0);
    expect((defaultOf(decl("uTint")) as RGB).r).toBe(1);
  });
});

describe("ParamSchema.coerce", () => {
  it("fills in a parameter the preset predates", () => {
    const { values } = schema.coerce({ uWarp: 1.2 });
    expect(values.uWarp).toBe(1.2);
    expect(values.uIters).toBe(8);
  });

  it("reports keys it does not recognise instead of dropping them silently", () => {
    // A preset written for a shader that has since lost a parameter. The
    // UI can say what it ignored; silence makes the user think the file
    // loaded correctly.
    const { unknown } = schema.coerce({ uWarp: 1, uGone: 3 });
    expect(unknown).toEqual(["uGone"]);
  });

  it("falls back to the default when a value has the wrong type", () => {
    // A parameter that used to be a float and is now an enum. Throwing
    // would lose the whole preset over one stale key.
    const { values, invalid } = schema.coerce({ uMode: 0.5, uWarp: 1.1 });
    expect(values.uMode).toBe("repeat");
    expect(values.uWarp).toBe(1.1);
    expect(invalid).toEqual(["uMode"]);
  });

  it("rejects an enum option that is not in the list", () => {
    const { values, invalid } = schema.coerce({ uMode: "kaleidoscope" });
    expect(values.uMode).toBe("repeat");
    expect(invalid).toContain("uMode");
  });

  it("clamps a number that is out of range rather than rejecting it", () => {
    // Out-of-range is usually a range that was tightened, not a corrupt
    // file, and the nearest legal value is what the author meant.
    const { values, invalid } = schema.coerce({ uWarp: 99, uIters: -4 });
    expect(values.uWarp).toBe(2);
    expect(values.uIters).toBe(1);
    expect(invalid).toEqual([]);
  });

  it("rounds a non-integer into an int parameter", () => {
    expect(schema.coerce({ uIters: 7.6 }).values.uIters).toBe(8);
  });

  it("does not clamp an angle to its declared range", () => {
    // Clamping a rotation turns "spun past the end" into "stuck", which is
    // visible on screen. Angles wrap by nature; the range is only there to
    // size the slider.
    expect(schema.coerce({ uAngle: 725 }).values.uAngle).toBe(725);
    expect(schema.coerce({ uAngle: -40 }).values.uAngle).toBe(-40);
  });

  it("rejects NaN and Infinity", () => {
    // NaN in a uniform propagates through the whole shader and produces a
    // black screen with no error anywhere.
    const { values, invalid } = schema.coerce({ uWarp: NaN, uMix: Infinity });
    expect(values.uWarp).toBe(0.5);
    expect(values.uMix).toBe(0.5);
    expect(invalid.sort()).toEqual(["uMix", "uWarp"]);
  });

  it("rejects a vector of the wrong length", () => {
    expect(schema.coerce({ uOffset: [1, 2, 3] }).invalid).toContain("uOffset");
    expect(schema.coerce({ uOffset: [0.5, -0.5] }).values.uOffset).toEqual([0.5, -0.5]);
  });

  it("clamps vector components", () => {
    expect(schema.coerce({ uOffset: [5, -5] }).values.uOffset).toEqual([1, -1]);
  });

  it("survives a malformed colour", () => {
    expect(schema.coerce({ uTint: "red" }).values.uTint).toEqual({ r: 1, g: 0.5, b: 0 });
    expect(schema.coerce({ uTint: null }).invalid).toContain("uTint");
    expect(schema.coerce({ uTint: { r: 2, g: -1, b: 0.5 } }).values.uTint).toEqual({
      r: 1,
      g: 0,
      b: 0.5,
    });
  });

  it("loads an empty preset as the full defaults", () => {
    expect(schema.coerce({}).values).toEqual(schema.defaults());
  });
});

describe("normalize / denormalize", () => {
  it("round-trips a linear float", () => {
    for (const v of [0, 0.37, 1.5, 2]) {
      expect(denormalize(decl("uWarp"), normalize(decl("uWarp"), v))).toBeCloseTo(v, 6);
    }
  });

  it("round-trips a log float", () => {
    for (const v of [0.1, 1, 10, 100]) {
      expect(denormalize(decl("uScale"), normalize(decl("uScale"), v)) as number).toBeCloseTo(v, 4);
    }
  });

  it("puts a log parameter's geometric middle at the middle of the knob", () => {
    // The reason the curve exists. 0.1–100 is three decades; a linear
    // mapping puts everything below 50 in the bottom half of the travel,
    // where no two positions look different.
    const mid = denormalize(decl("uScale"), 0.5) as number;
    expect(mid).toBeCloseTo(Math.sqrt(0.1 * 100), 3); // ≈3.16

    const linearMid = denormalize(decl("uWarp"), 0.5) as number;
    expect(linearMid).toBeCloseTo(1, 6);
  });

  it("hits both ends of the range exactly", () => {
    expect(denormalize(decl("uWarp"), 0)).toBe(0);
    expect(denormalize(decl("uWarp"), 1)).toBe(2);
    expect(denormalize(decl("uScale"), 0) as number).toBeCloseTo(0.1, 6);
    expect(denormalize(decl("uScale"), 1) as number).toBeCloseTo(100, 6);
  });

  it("clamps out-of-range input rather than extrapolating", () => {
    expect(denormalize(decl("uWarp"), 1.7)).toBe(2);
    expect(denormalize(decl("uWarp"), -0.5)).toBe(0);
  });

  it("quantises to the declared step without floating-point litter", () => {
    // 0.30000000000000004 in a saved preset and in the UI readout is the
    // classic symptom of accumulating a step in a loop.
    const d = decl("uMix");
    for (let i = 0; i <= 10; i++) {
      const v = denormalize(d, i / 10) as number;
      expect(String(v)).toMatch(/^-?\d+(\.\d)?$/);
    }
    expect(denormalize(d, 0.34)).toBe(0.3);
  });

  it("always yields a whole number for an int", () => {
    for (let i = 0; i <= 20; i++) {
      expect(Number.isInteger(denormalize(decl("uIters"), i / 20))).toBe(true);
    }
  });

  it("spreads enum options evenly and never indexes past the end", () => {
    const d = decl("uMode");
    expect(denormalize(d, 0)).toBe("mirror");
    expect(denormalize(d, 0.5)).toBe("repeat");
    // The off-by-one that a naive floor(x * n) hits exactly at the top.
    expect(denormalize(d, 1)).toBe("clamp");
  });

  it("round-trips every enum option", () => {
    const d = decl("uMode");
    for (const opt of ["mirror", "repeat", "clamp"]) {
      expect(denormalize(d, normalize(d, opt))).toBe(opt);
    }
  });

  it("puts an unknown enum value at the start rather than off the scale", () => {
    // indexOf returns -1; using it directly would put the slider at a
    // negative position.
    expect(normalize(decl("uMode"), "nope")).toBe(0);
  });

  it("treats bool as a threshold at the midpoint", () => {
    expect(denormalize(decl("uInvert"), 0.49)).toBe(false);
    expect(denormalize(decl("uInvert"), 0.5)).toBe(true);
    expect(normalize(decl("uInvert"), true)).toBe(1);
  });
});
