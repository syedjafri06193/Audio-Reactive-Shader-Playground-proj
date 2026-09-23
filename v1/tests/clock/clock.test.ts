import { describe, expect, it } from "vitest";

import { ClockDrift, MAX_DT, computeTiming } from "../../src/clock/loop.js";
import { lookaheadSeconds, measureLatency, summarizeLatency } from "../../src/audio/latency.js";

describe("computeTiming", () => {
  it("reports dt in seconds", () => {
    expect(computeTiming(1016.7, 1000, 0, 0).dt).toBeCloseTo(0.0167, 6);
  });

  it("clamps a huge dt from a backgrounded tab", () => {
    // A hidden tab throttles rAF to ~1 Hz while the AudioContext keeps
    // running, so the first frame back carries several seconds. Anything
    // integrating dt — a rotation, a trail, a particle system — jumps that
    // whole interval in one frame, which is a violent lurch on focus.
    const t = computeTiming(11000, 1000, 0, 0);
    expect(t.rawDt).toBeCloseTo(10, 6);
    expect(t.dt).toBe(MAX_DT);
  });

  it("clamps at 20 fps, not lower", () => {
    // Below this the animation is already broken; running it in slow
    // motion is less bad than tearing it apart.
    expect(MAX_DT).toBeCloseTo(1 / 20, 6);
    expect(computeTiming(1050, 1000, 0, 0).dt).toBe(MAX_DT);
    expect(computeTiming(1040, 1000, 0, 0).dt).toBeCloseTo(0.04, 6);
  });

  it("never reports a negative dt", () => {
    // Some browsers have delivered a rAF timestamp slightly behind the
    // previous one. A negative dt runs the simulation backwards.
    expect(computeTiming(900, 1000, 0, 0).dt).toBe(0);
  });

  it("keeps the two clocks separate", () => {
    // The audio clock and the UI clock drift, and the musical one must not
    // be derived from the visual one.
    const t = computeTiming(5000, 4983, 12.5, 7);
    expect(t.audioTime).toBe(12.5);
    expect(t.uiTime).toBeCloseTo(5, 6);
    expect(t.frame).toBe(7);
  });
});

describe("ClockDrift", () => {
  it("reports nothing on the first sample", () => {
    expect(new ClockDrift().sample(10, 10)).toBeNull();
  });

  it("measures the UI clock running ahead of the audio clock", () => {
    const d = new ClockDrift();
    d.sample(100, 100);
    // Ten seconds of UI time against 9.99 seconds of audio time.
    expect(d.sample(109.99, 110)).toBeCloseTo(0.01, 6);
  });

  it("reports zero when the clocks agree", () => {
    const d = new ClockDrift();
    d.sample(0, 0);
    expect(d.sample(60, 60)).toBeCloseTo(0, 9);
  });

  it("restarts from a reset", () => {
    const d = new ClockDrift();
    d.sample(0, 0);
    d.sample(10, 11);
    d.reset();
    expect(d.sample(100, 100)).toBeNull();
  });
});

describe("measureLatency", () => {
  const base = { sampleRate: 48000, fftSize: 4096 };

  it("charges half the analysis window, not the whole one", () => {
    // The FFT result describes the window's centre, not its end.
    const r = measureLatency(base);
    expect(r.analysisMs).toBeCloseTo((4096 / 48000) * 1000 * 0.5, 3);
    expect(r.analysisMs).toBeCloseTo(42.7, 1);
  });

  it("treats the analysis window as inherent rather than as overhead", () => {
    // Resolving a 40 Hz note requires observing a cycle of it. No amount
    // of optimisation changes that, so it is excluded from the
    // controllable figure.
    const r = measureLatency({ ...base, frameMs: 16.7, baseLatency: 0.005 });
    expect(r.controllableMs).toBeCloseTo(21.7, 1);
    expect(r.controllableMs).toBeLessThan(r.analysisMs);
  });

  it("scales with FFT size", () => {
    const small = measureLatency({ ...base, fftSize: 1024 });
    const large = measureLatency({ ...base, fftSize: 8192 });
    expect(large.analysisMs).toBeCloseTo(small.analysisMs * 8, 3);
  });

  it("names Bluetooth as the cause of a large output latency", () => {
    // Otherwise it reads as "the tool is broken" rather than "the
    // headphones are the problem", and no setting here can change it.
    const r = measureLatency({ ...base, outputLatency: 0.22 });
    expect(r.outputMs).toBeCloseTo(220, 1);
    expect(r.notes.join(" ")).toMatch(/Bluetooth/i);
    expect(r.verdict).toBe("unusable");
  });

  it("says an unreported output latency is unknown, not zero", () => {
    // Firefox reports 0 and Safari has historically not implemented it.
    // Treating that as "no latency" understates the budget on exactly the
    // platforms where it matters.
    const r = measureLatency(base);
    expect(r.notes.join(" ")).toMatch(/does not report output latency/i);
  });

  it("discounts the analysis window for a file source", () => {
    // A file can be analysed ahead of the playhead. Live input cannot:
    // the audio does not exist yet.
    const live = measureLatency({ ...base, canAnalyzeAhead: false });
    const file = measureLatency({ ...base, canAnalyzeAhead: true });
    expect(file.totalMs).toBeCloseTo(live.totalMs - live.analysisMs, 3);
    expect(file.notes.join(" ")).toMatch(/analysis can run ahead/i);
  });

  it("grades the budget in bands a user can act on", () => {
    expect(measureLatency({ ...base, fftSize: 1024, frameMs: 8 }).verdict).toBe("tight");
    expect(measureLatency({ ...base, fftSize: 8192 }).verdict).toBe("acceptable");
    expect(measureLatency({ ...base, fftSize: 16384 }).verdict).toBe("loose");
    expect(measureLatency({ ...base, outputLatency: 0.3 }).verdict).toBe("unusable");
  });

  it("puts the default configuration right on the tight/acceptable line", () => {
    // 4096 at 48 kHz plus one 60 Hz frame is 59.4 ms — just inside
    // "tight", with no margin. Worth knowing: a 30 Hz display, or any
    // reported output latency at all, moves the default into
    // "acceptable". This is the trade the 4096 window buys, and it is the
    // right one, because 1024 cannot separate musical notes at 40–80 Hz.
    const r = measureLatency({ ...base, frameMs: 16.7 });
    expect(r.totalMs).toBeCloseTo(59.4, 1);
    expect(r.verdict).toBe("tight");
    expect(measureLatency({ ...base, frameMs: 33.3 }).verdict).toBe("acceptable");
  });

  it("suggests the FFT trade-off only when the budget is actually loose", () => {
    expect(measureLatency({ ...base, fftSize: 16384 }).notes.join(" ")).toMatch(
      /bass frequency resolution/i,
    );
    expect(measureLatency({ ...base, fftSize: 1024, frameMs: 8 }).notes.join(" ")).not.toMatch(
      /bass frequency resolution/i,
    );
  });

  it("summarises in one line", () => {
    const s = summarizeLatency(measureLatency(base));
    expect(s).toMatch(/ms/);
    expect(s).toMatch(/analysis/);
  });
});

describe("lookaheadSeconds", () => {
  it("is zero for live input, because the audio has not happened yet", () => {
    const r = measureLatency({ sampleRate: 48000, fftSize: 4096 });
    expect(lookaheadSeconds(r, false)).toBe(0);
  });

  it("compensates the predictable parts for a file", () => {
    const r = measureLatency({ sampleRate: 48000, fftSize: 4096, frameMs: 16.7 });
    expect(lookaheadSeconds(r, true)).toBeCloseTo((r.analysisMs + r.frameMs) / 1000, 6);
  });

  it("excludes output latency from the compensation", () => {
    // Output latency is often misreported, and over-compensating pushes
    // the visuals *ahead* of the music — the one direction that is never
    // acceptable.
    const withBt = measureLatency({ sampleRate: 48000, fftSize: 4096, outputLatency: 0.25 });
    const without = measureLatency({ sampleRate: 48000, fftSize: 4096 });
    expect(lookaheadSeconds(withBt, true)).toBeCloseTo(lookaheadSeconds(without, true), 9);
  });
});
