import { describe, expect, it } from "vitest";

import { ParamSchema, type ParamDecl } from "../../src/params/schema.js";
import {
  ModulationEngine,
  applyModCurve,
  emptyModulation,
  evaluateLfo,
  isModulatable,
  makeRoute,
  sampleSources,
  type ModRoute,
  type ModSourceName,
  type ModulationState,
} from "../../src/params/modulation.js";
import type { AudioFeatures } from "../../src/audio/features.js";

const DECLS: ParamDecl[] = [
  { name: "uWarp", label: "Warp", type: "float", min: 0, max: 1, default: 0.5 },
  { name: "uGain", label: "Gain", type: "float", min: 0, max: 10, default: 0 },
  { name: "uIters", label: "Iterations", type: "int", min: 1, max: 32, default: 8 },
  { name: "uAngle", label: "Angle", type: "angle", min: 0, max: 360, default: 0 },
  { name: "uTint", label: "Tint", type: "color", default: { r: 1, g: 0, b: 0 } },
  { name: "uMode", label: "Mode", type: "enum", options: ["a", "b"], default: "a" },
];

const schema = new ParamSchema(DECLS);

function features(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    sub: 0,
    bass: 0,
    lowMid: 0,
    mid: 0,
    highMid: 0,
    treble: 0,
    rms: 0,
    peak: 0,
    centroidHz: 0,
    centroid: 0,
    flux: 0,
    onset: false,
    onsetEnvelope: 0,
    bpm: null,
    beatPhase: 0,
    beatConfidence: 0,
    logSpectrum: new Float32Array(32),
    ...overrides,
  };
}

/** Every source at zero, with the named ones overridden. */
function srcTable(overrides: Partial<Record<ModSourceName, number>>): Record<ModSourceName, number> {
  return { ...sampleSources(features(), emptyModulation(), 0), ...overrides };
}

function state(routes: ModRoute[]): ModulationState {
  return { ...emptyModulation(), routes };
}

describe("sampleSources", () => {
  it("exposes every declared source, normalised", () => {
    const table = sampleSources(
      features({ rms: 0.4, bass: 0.7, treble: 0.2, centroid: 0.6, onsetEnvelope: 0.9 }),
      emptyModulation(),
      0,
    );
    expect(table.level).toBe(0.4);
    expect(table.bass).toBe(0.7);
    expect(table.treble).toBe(0.2);
    expect(table.centroid).toBe(0.6);
    expect(table.onset).toBe(0.9);
  });

  it("carries the onset envelope rather than the boolean", () => {
    // A route on a raw boolean would be on for exactly one frame, which at
    // 60 fps is 16 ms — below the threshold at which anyone sees it.
    const table = sampleSources(features({ onset: true, onsetEnvelope: 0.55 }), emptyModulation(), 0);
    expect(table.onset).toBe(0.55);
  });

  it("evaluates both LFOs once, so two routes on one LFO agree", () => {
    const mod = emptyModulation();
    mod.lfo1 = { rate: 1, shape: "saw" };
    const a = sampleSources(features(), mod, 0.25);
    const b = sampleSources(features(), mod, 0.25);
    expect(a.lfo1).toBe(b.lfo1);
  });
});

describe("evaluateLfo", () => {
  it("stays within 0–1 for every shape", () => {
    for (const shape of ["sine", "triangle", "saw", "square"] as const) {
      for (let i = 0; i < 40; i++) {
        const v = evaluateLfo({ rate: 1, shape }, i / 10, null, 0);
        expect(v, shape).toBeGreaterThanOrEqual(0);
        expect(v, shape).toBeLessThanOrEqual(1);
      }
    }
  });

  it("completes exactly one cycle per second at rate 1", () => {
    const lfo = { rate: 1, shape: "saw" as const };
    expect(evaluateLfo(lfo, 0, null, 0)).toBeCloseTo(0, 6);
    expect(evaluateLfo(lfo, 0.5, null, 0)).toBeCloseTo(0.5, 6);
    expect(evaluateLfo(lfo, 1.0, null, 0)).toBeCloseTo(0, 6);
  });

  it("starts a sine at its midpoint, not at zero", () => {
    // A sine LFO that began at 0 would jump a half-swing on its first
    // cycle. Starting at the midpoint is what makes it a modulator rather
    // than an envelope.
    expect(evaluateLfo({ rate: 1, shape: "sine" }, 0, null, 0)).toBeCloseTo(0.5, 6);
  });

  it("follows the beat when synced instead of free-running", () => {
    const lfo = { rate: 1, shape: "saw" as const, sync: true };
    // Same audio time, different beat phase — the synced LFO tracks the
    // beat, so a tempo change re-locks it rather than leaving it drifting.
    expect(evaluateLfo(lfo, 100, 120, 0.25)).toBeCloseTo(0.25, 6);
    expect(evaluateLfo(lfo, 100, 120, 0.75)).toBeCloseTo(0.75, 6);
  });

  it("falls back to free-running when there is no tempo yet", () => {
    const lfo = { rate: 1, shape: "saw" as const, sync: true };
    // bpm is null for the first few seconds of any track. Freezing at 0
    // until the tracker locks would look like the LFO was broken.
    expect(evaluateLfo(lfo, 0.3, null, 0)).toBeCloseTo(0.3, 6);
  });

  it("handles a negative phase offset without going out of range", () => {
    const v = evaluateLfo({ rate: 1, shape: "saw", phase: -0.25 }, 0, null, 0);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
    expect(v).toBeCloseTo(0.75, 6);
  });
});

describe("applyModCurve", () => {
  it("pins both ends for every curve", () => {
    for (const c of ["linear", "exp", "log", "scurve"] as const) {
      expect(applyModCurve(0, c), c).toBeCloseTo(0, 6);
      expect(applyModCurve(1, c), c).toBeCloseTo(1, 6);
    }
  });

  it("bends exp down and log up in the middle", () => {
    // Which is the whole point: `exp` pulls the response into the quiet
    // part of a loudness signal, `log` pushes it out of it.
    expect(applyModCurve(0.5, "exp")).toBeLessThan(0.5);
    expect(applyModCurve(0.5, "log")).toBeGreaterThan(0.5);
    expect(applyModCurve(0.5, "linear")).toBeCloseTo(0.5, 6);
  });

  it("is monotone for every curve", () => {
    for (const c of ["linear", "exp", "log", "scurve"] as const) {
      let prev = -1;
      for (let i = 0; i <= 20; i++) {
        const v = applyModCurve(i / 20, c);
        expect(v, c).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it("clamps rather than extrapolating out of range", () => {
    expect(applyModCurve(1.5, "exp")).toBe(1);
    expect(applyModCurve(-2, "log")).toBe(0);
  });
});

describe("ModulationEngine", () => {
  const base = { uWarp: 0.5, uGain: 0, uIters: 8, uAngle: 0, uTint: { r: 1, g: 0, b: 0 }, uMode: "a" };

  it("offsets the base value rather than replacing it", () => {
    // The property that keeps a slider usable during a performance. If
    // modulation replaced the base, moving the slider while the music
    // played would do nothing.
    const engine = new ModulationEngine(schema);
    const mod = state([makeRoute("bass", "uWarp", 0.4, { smoothingSeconds: 0 })]);
    const src = srcTable({ bass: 1 });

    const quiet = engine.apply({ ...base, uWarp: 0.1 }, mod, srcTable({ bass: 0 }), 1 / 60);
    const loud = engine.apply({ ...base, uWarp: 0.1 }, mod, src, 1 / 60);

    expect(quiet.values.uWarp).toBeCloseTo(0.1, 6);
    expect(loud.values.uWarp).toBeCloseTo(0.5, 6); // 0.1 + 0.4 of the range

    // And a different base shifts the whole response.
    const higher = engine.apply({ ...base, uWarp: 0.3 }, mod, src, 1 / 60);
    expect(higher.values.uWarp).toBeCloseTo(0.7, 6);
  });

  it("does not mutate the base table", () => {
    // The UI holds this object. Writing modulated values into it would
    // make the sliders twitch with the music and then stay wherever the
    // last frame left them.
    const engine = new ModulationEngine(schema);
    const mod = state([makeRoute("bass", "uWarp", 0.4, { smoothingSeconds: 0 })]);
    const input = { ...base };
    engine.apply(input, mod, srcTable({ bass: 1 }), 1 / 60);
    expect(input.uWarp).toBe(0.5);
  });

  it("sums routes to the same target and clamps once", () => {
    // Clamping per route would make the second +0.6 do nothing at all,
    // and the user would conclude the route was broken.
    const engine = new ModulationEngine(schema);
    const mod = state([
      makeRoute("bass", "uWarp", 0.6, { id: "r1", smoothingSeconds: 0 }),
      makeRoute("treble", "uWarp", 0.6, { id: "r2", smoothingSeconds: 0 }),
    ]);

    const both = engine.apply({ ...base, uWarp: 0 }, mod, srcTable({ bass: 1, treble: 1 }), 1 / 60);
    expect(both.values.uWarp).toBe(1); // clamped at the top of the range

    const one = engine.apply({ ...base, uWarp: 0 }, mod, srcTable({ bass: 1, treble: 0 }), 1 / 60);
    expect(one.values.uWarp).toBeCloseTo(0.6, 6);

    // Both contributions are reported even though the sum saturated, so
    // the UI can show that the second route *is* doing something.
    expect(both.activity).toHaveLength(2);
    expect(both.activity.every((a) => a.contribution > 0)).toBe(true);
  });

  it("lets a negative amount pull the parameter down", () => {
    const engine = new ModulationEngine(schema);
    const mod = state([makeRoute("bass", "uWarp", -0.4, { smoothingSeconds: 0 })]);
    const out = engine.apply({ ...base, uWarp: 0.5 }, mod, srcTable({ bass: 1 }), 1 / 60);
    expect(out.values.uWarp).toBeCloseTo(0.1, 6);
  });

  it("scales amount to the target's own range, not to raw units", () => {
    // uGain spans 0–10. An amount of 0.5 should sweep half of it, so that
    // repointing a route does not require retuning the amount.
    const engine = new ModulationEngine(schema);
    const mod = state([makeRoute("bass", "uGain", 0.5, { smoothingSeconds: 0 })]);
    const out = engine.apply(base, mod, srcTable({ bass: 1 }), 1 / 60);
    expect(out.values.uGain).toBeCloseTo(5, 6);
  });

  it("leaves a unipolar route's target alone when the source is silent", () => {
    const engine = new ModulationEngine(schema);
    const mod = state([makeRoute("bass", "uWarp", 0.4, { smoothingSeconds: 0 })]);
    const out = engine.apply(base, mod, srcTable({ bass: 0 }), 1 / 60);
    expect(out.values.uWarp).toBeCloseTo(0.5, 6);
  });

  it("swings both ways for a bipolar route", () => {
    // The distinction that matters musically: unipolar means "louder adds
    // more", bipolar means "quiet subtracts and loud adds".
    const engine = new ModulationEngine(schema);
    const mod = state([makeRoute("bass", "uWarp", 0.4, { smoothingSeconds: 0, bipolar: true })]);

    expect(engine.apply(base, mod, srcTable({ bass: 0.5 }), 1 / 60).values.uWarp).toBeCloseTo(0.5, 6);
    expect(engine.apply(base, mod, srcTable({ bass: 1 }), 1 / 60).values.uWarp).toBeCloseTo(0.9, 6);
    expect(engine.apply(base, mod, srcTable({ bass: 0 }), 1 / 60).values.uWarp).toBeCloseTo(0.1, 6);
  });

  it("keeps an int target integral", () => {
    const engine = new ModulationEngine(schema);
    const mod = state([makeRoute("bass", "uIters", 0.5, { smoothingSeconds: 0 })]);
    for (let i = 0; i <= 10; i++) {
      const out = engine.apply(base, mod, srcTable({ bass: i / 10 }), 1 / 60);
      expect(Number.isInteger(out.values.uIters)).toBe(true);
    }
  });

  it("refuses to modulate a colour or an enum, and says why", () => {
    // "80% of the way along" is undefined for both. Picking an axis
    // arbitrarily would produce behaviour nobody could predict.
    const engine = new ModulationEngine(schema);
    const mod = state([
      makeRoute("bass", "uTint", 1, { id: "c" }),
      makeRoute("bass", "uMode", 1, { id: "e" }),
    ]);
    const out = engine.apply(base, mod, srcTable({ bass: 1 }), 1 / 60);

    expect(out.rejected.map((r) => r.id).sort()).toEqual(["c", "e"]);
    expect(out.rejected[0].reason).toMatch(/cannot be modulated/);
    expect(out.values.uTint).toEqual({ r: 1, g: 0, b: 0 });
    expect(out.values.uMode).toBe("a");
  });

  it("reports a route pointing at a parameter that no longer exists", () => {
    // Normal after editing a shader. The route should be flagged, not
    // crash and not silently vanish.
    const engine = new ModulationEngine(schema);
    const mod = state([makeRoute("bass", "uDeleted", 1, { id: "gone" })]);
    const out = engine.apply(base, mod, srcTable({ bass: 1 }), 1 / 60);
    expect(out.rejected).toEqual([{ id: "gone", reason: 'no parameter named "uDeleted"' }]);
  });

  it("skips a disabled route", () => {
    const engine = new ModulationEngine(schema);
    const mod = state([makeRoute("bass", "uWarp", 0.4, { smoothingSeconds: 0, enabled: false })]);
    const out = engine.apply(base, mod, srcTable({ bass: 1 }), 1 / 60);
    expect(out.values.uWarp).toBe(0.5);
    expect(out.activity).toHaveLength(0);
  });

  it("returns the base table untouched when nothing is routed", () => {
    const engine = new ModulationEngine(schema);
    const out = engine.apply(base, emptyModulation(), srcTable({ bass: 1 }), 1 / 60);
    expect(out.values).toBe(base);
  });
});

describe("ModulationEngine smoothing", () => {
  const base = { uWarp: 0, uGain: 0, uIters: 8, uAngle: 0, uTint: { r: 1, g: 0, b: 0 }, uMode: "a" };

  it("reaches the same place after the same elapsed time at any frame rate", () => {
    // The `1 - exp(-dt/tau)` form. A fixed per-frame coefficient smooths
    // over a number of *frames*, so the same patch responds twice as fast
    // on a 120 Hz display — a real difference on hardware people own.
    const SECONDS = 0.5;
    const TAU = 0.2;

    const run = (fps: number) => {
      const engine = new ModulationEngine(schema);
      const mod = state([makeRoute("bass", "uWarp", 1, { id: "r", smoothingSeconds: TAU })]);
      const dt = 1 / fps;

      // Settle at zero, then step the source to 1. The frame count is an
      // integer rather than an accumulated `t += dt` — accumulating the
      // clock in floating point runs an extra frame at some rates and
      // puts the difference in the test rather than in the filter.
      engine.apply(base, mod, srcTable({ bass: 0 }), dt);
      const frames = Math.round(SECONDS * fps);
      let last = 0;
      for (let i = 0; i < frames; i++) {
        last = engine.apply(base, mod, srcTable({ bass: 1 }), dt).values.uWarp as number;
      }
      return last;
    };

    // Not merely close to each other — all three land on the analytic
    // value, which is what "frame-rate independent" actually means.
    const analytic = 1 - Math.exp(-SECONDS / TAU);
    for (const fps of [30, 60, 120, 144]) {
      expect(run(fps), `${fps} fps`).toBeCloseTo(analytic, 9);
    }
  });

  it("approaches but does not overshoot the target", () => {
    const engine = new ModulationEngine(schema);
    const mod = state([makeRoute("bass", "uWarp", 1, { id: "r", smoothingSeconds: 0.2 })]);
    engine.apply(base, mod, srcTable({ bass: 0 }), 1 / 60);

    let prev = 0;
    for (let i = 0; i < 200; i++) {
      const v = engine.apply(base, mod, srcTable({ bass: 1 }), 1 / 60).values.uWarp as number;
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
      prev = v;
    }
    expect(prev).toBeCloseTo(1, 3);
  });

  it("passes an unsmoothed route through immediately", () => {
    // What an onset flash needs. Any smoothing at all turns a hit into a
    // swell, which is the wrong gesture entirely.
    const engine = new ModulationEngine(schema);
    const mod = state([makeRoute("onset", "uWarp", 1, { smoothingSeconds: 0 })]);
    expect(engine.apply(base, mod, srcTable({ onset: 1 }), 1 / 60).values.uWarp).toBe(1);
  });

  it("starts a newly added route at its source rather than ramping from zero", () => {
    // Adding a route mid-performance should take effect, not fade in over
    // a second while the user wonders whether they clicked the button.
    const engine = new ModulationEngine(schema);
    const mod = state([makeRoute("bass", "uWarp", 1, { id: "new", smoothingSeconds: 0.5 })]);
    expect(engine.apply(base, mod, srcTable({ bass: 0.8 }), 1 / 60).values.uWarp).toBeCloseTo(0.8, 6);
  });

  it("keeps each route's filter separate", () => {
    const engine = new ModulationEngine(schema);
    const mod = state([
      makeRoute("bass", "uWarp", 0.5, { id: "slow", smoothingSeconds: 0.5 }),
      makeRoute("treble", "uGain", 0.5, { id: "fast", smoothingSeconds: 0 }),
    ]);
    engine.apply(base, mod, srcTable({ bass: 0, treble: 0 }), 1 / 60);
    const out = engine.apply(base, mod, srcTable({ bass: 1, treble: 1 }), 1 / 60);

    const slow = out.activity.find((a) => a.id === "slow")!;
    const fast = out.activity.find((a) => a.id === "fast")!;
    expect(fast.value).toBe(1);
    expect(slow.value).toBeLessThan(0.5);
  });

  it("drops filter state for routes that were deleted", () => {
    const engine = new ModulationEngine(schema);
    const withRoute = state([makeRoute("bass", "uWarp", 1, { id: "r", smoothingSeconds: 0.5 })]);
    engine.apply(base, withRoute, srcTable({ bass: 1 }), 1 / 60);

    engine.prune(emptyModulation());

    // Re-adding the same id must start fresh, not resume an old filter.
    const out = engine.apply(base, withRoute, srcTable({ bass: 0.2 }), 1 / 60);
    expect(out.values.uWarp).toBeCloseTo(0.2, 6);
  });
});

describe("isModulatable", () => {
  it("accepts numeric parameters and rejects the rest", () => {
    expect(isModulatable(schema.get("uWarp")!)).toBe(true);
    expect(isModulatable(schema.get("uIters")!)).toBe(true);
    expect(isModulatable(schema.get("uAngle")!)).toBe(true);
    expect(isModulatable(schema.get("uTint")!)).toBe(false);
    expect(isModulatable(schema.get("uMode")!)).toBe(false);
  });
});

describe("makeRoute", () => {
  it("smooths a little by default", () => {
    // Raw analyser output at 60 fps is visibly steppy on anything
    // geometric, and the usual first reaction is that the analysis is
    // broken rather than that the route needs a filter.
    expect(makeRoute("bass", "uWarp", 1).smoothingSeconds).toBeGreaterThan(0);
  });

  it("gives every route a distinct id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeRoute("bass", "uWarp", 1).id));
    expect(ids.size).toBe(50);
  });
});
