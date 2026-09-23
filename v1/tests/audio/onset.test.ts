import { describe, expect, it } from "vitest";

import { BeatTracker } from "../../src/audio/beat.js";
import { OnsetDetector, OnsetEnvelope } from "../../src/audio/onset.js";
import { SAMPLE_RATE, bandNoise, byteSpectrum, clickTrack, noise, sine } from "./fixtures.js";

const TRANSIENT_FFT = 512;
/** ~60 fps at 48 kHz, which is what the render loop actually produces. */
const HOP = 800;

interface Detection {
  timeSeconds: number;
  flux: number;
}

/**
 * Run the detector across a signal the way the render loop would, and
 * return when it fired.
 */
function runDetector(
  samples: Float64Array,
  options: ConstructorParameters<typeof OnsetDetector>[1] = {},
): Detection[] {
  const detector = new OnsetDetector(TRANSIENT_FFT / 2, options);
  const out: Detection[] = [];

  for (let offset = 0; offset + TRANSIENT_FFT <= samples.length; offset += HOP) {
    const spectrum = byteSpectrum(samples, { fftSize: TRANSIENT_FFT, offset });
    // The window's end: the earliest moment its contents could be known.
    const t = (offset + TRANSIENT_FFT) / SAMPLE_RATE;
    const { flux, onset } = detector.detect(spectrum, t * 1000);
    if (onset) out.push({ timeSeconds: t, flux });
  }
  return out;
}

describe("OnsetDetector", () => {
  it("finds the clicks in a click track", () => {
    const track = clickTrack({ bpm: 120, bars: 4 });
    const detections = runDetector(track.samples);

    // 4 bars x 4 beats. Allow a small shortfall: the very first click has no
    // history to build a threshold against, and the last may fall inside the
    // trailing partial window.
    expect(detections.length).toBeGreaterThanOrEqual(14);
    expect(detections.length).toBeLessThanOrEqual(16);
  });

  it("finds them close to where they actually are", () => {
    const track = clickTrack({ bpm: 120, bars: 4 });
    const detections = runDetector(track.samples);

    for (const d of detections) {
      const nearest = track.clickOffsets
        .map((o) => Math.abs(d.timeSeconds - o / SAMPLE_RATE))
        .reduce((a, b) => Math.min(a, b));

      // The detection lands after the click, never before — the analysis
      // window has to contain the transient before flux can see it. The
      // window is 10.7 ms and the hop is 16.7 ms, so a detection up to
      // roughly one window plus one hop late is expected and unavoidable.
      expect(nearest).toBeLessThan(0.05);
    }
  });

  it("does not fire on silence", () => {
    expect(runDetector(new Float64Array(SAMPLE_RATE * 2))).toHaveLength(0);
  });

  it("does not fire on a steady tone", () => {
    // A sustained note has large amplitude and no attacks. An amplitude
    // detector fires continuously here; a flux detector should not fire at
    // all after the initial onset.
    const detections = runDetector(sine(440, 2.0));
    expect(detections.length).toBeLessThanOrEqual(2);
  });

  it("does not fire on steady noise", () => {
    // Steady broadband noise has large *change* frame to frame but no
    // attacks, and the adaptive median threshold is what keeps it quiet.
    const detections = runDetector(noise(2.0));
    expect(detections.length).toBeLessThanOrEqual(3);
  });

  it("finds an attack layered on top of a sustained pad", () => {
    // The case amplitude thresholding misses: a hit that barely moves the
    // overall level because a pad is already loud.
    const pad = bandNoise(200, 800, 2.0, 0.6);
    const mixed = Float64Array.from(pad);

    const hitOffsets = [Math.floor(0.6 * SAMPLE_RATE), Math.floor(1.2 * SAMPLE_RATE)];
    const burst = noise(0.01, 0.9, 999);
    for (const start of hitOffsets) {
      for (let i = 0; i < burst.length; i++) {
        mixed[start + i] += burst[i] * Math.exp((-8 * i) / burst.length);
      }
    }

    const detections = runDetector(mixed);
    for (const start of hitOffsets) {
      const t = start / SAMPLE_RATE;
      const found = detections.some((d) => d.timeSeconds >= t && d.timeSeconds - t < 0.06);
      expect(found, `no onset found for the hit at ${t.toFixed(2)}s`).toBe(true);
    }
  });

  it("keeps working across a quiet passage and a loud one", () => {
    // What the adaptive median buys. A fixed threshold tuned on the quiet
    // half fires continuously through the loud half; one tuned on the loud
    // half detects nothing in the quiet half.
    const quiet = clickTrack({ bpm: 120, bars: 2 });
    const loud = clickTrack({ bpm: 120, bars: 2 });
    for (let i = 0; i < quiet.samples.length; i++) quiet.samples[i] *= 0.15;

    const joined = new Float64Array(quiet.samples.length + loud.samples.length);
    joined.set(quiet.samples, 0);
    joined.set(loud.samples, quiet.samples.length);

    const detections = runDetector(joined);
    const boundary = quiet.samples.length / SAMPLE_RATE;
    const inQuiet = detections.filter((d) => d.timeSeconds < boundary).length;
    const inLoud = detections.filter((d) => d.timeSeconds >= boundary).length;

    expect(inQuiet, "detected nothing in the quiet passage").toBeGreaterThanOrEqual(4);
    expect(inLoud, "detected nothing in the loud passage").toBeGreaterThanOrEqual(4);
  });

  it("does not report one hit three times", () => {
    // A single drum hit spreads across two or three analysis frames. The
    // refractory period is what stops that becoming three onsets.
    const track = clickTrack({ bpm: 60, bars: 2 });
    const detections = runDetector(track.samples);

    for (let i = 1; i < detections.length; i++) {
      const gap = detections[i].timeSeconds - detections[i - 1].timeSeconds;
      expect(gap).toBeGreaterThanOrEqual(0.079);
    }
  });

  it("fires more without a refractory period, which is why there is one", () => {
    const track = clickTrack({ bpm: 90, bars: 4 });
    const guarded = runDetector(track.samples);
    const unguarded = runDetector(track.samples, { refractoryMs: 0 });
    expect(unguarded.length).toBeGreaterThanOrEqual(guarded.length);
  });

  it("counts only increases, so a note ending is not an onset", () => {
    // Half-wave rectification. Without it, flux measures general change and
    // every release fires as loudly as every attack.
    const detector = new OnsetDetector(4);

    const rising = new Uint8Array([0, 10, 10, 10]);
    const falling = new Uint8Array([0, 200, 200, 200]);

    detector.detect(falling, 0); // establish a high previous frame
    const drop = detector.detect(rising, 1000); // a large *decrease*

    expect(drop.flux).toBe(0);
    expect(drop.onset).toBe(false);
  });

  it("survives a change of fftSize rather than reading past the end", () => {
    const detector = new OnsetDetector(256);
    expect(() => detector.detect(new Uint8Array(1024), 0)).not.toThrow();
    expect(() => detector.detect(new Uint8Array(64), 100)).not.toThrow();
  });

  it("forgets its history on reset", () => {
    const detector = new OnsetDetector(8);
    for (let i = 0; i < 50; i++) {
      detector.detect(new Uint8Array(8).fill(200), i * 100);
    }
    detector.reset();
    const after = detector.detect(new Uint8Array(8).fill(200), 10_000);
    // With a cleared `prev`, the first frame after a reset is all increase.
    expect(after.flux).toBeGreaterThan(0);
  });
});

describe("OnsetEnvelope", () => {
  it("jumps on an onset and decays after it", () => {
    const env = new OnsetEnvelope(4);
    expect(env.update(true, 1, 1 / 60)).toBeGreaterThan(0.9);

    let v = env.current;
    for (let i = 0; i < 10; i++) {
      const next = env.update(false, 0, 1 / 60);
      expect(next).toBeLessThan(v);
      v = next;
    }
  });

  it("decays at the same rate regardless of frame rate", () => {
    // The property that makes `1 - exp(-rate * dt)` worth the exp() call. A
    // fixed per-frame multiplier decays more than twice as fast on a 144 Hz
    // monitor, which is a real bug on hardware people own.
    const at60 = new OnsetEnvelope(4);
    const at144 = new OnsetEnvelope(4);

    at60.update(true, 1, 1 / 60);
    at144.update(true, 1, 1 / 144);

    for (let i = 0; i < 60; i++) at60.update(false, 0, 1 / 60);
    for (let i = 0; i < 144; i++) at144.update(false, 0, 1 / 144);

    // One second of decay either way.
    expect(at60.current).toBeCloseTo(at144.current, 2);
  });

  it("does not lower itself when a second hit lands during the decay", () => {
    const env = new OnsetEnvelope(4);
    env.update(true, 1.0, 1 / 60);
    const high = env.current;
    const afterQuietHit = env.update(true, 0.2, 1 / 60);
    expect(afterQuietHit).toBeGreaterThan(high * 0.8);
  });

  it("reaches zero and stays there", () => {
    const env = new OnsetEnvelope(8);
    env.update(true, 1, 1 / 60);
    for (let i = 0; i < 600; i++) env.update(false, 0, 1 / 60);
    expect(env.current).toBeLessThan(1e-6);
    expect(env.current).toBeGreaterThanOrEqual(0);
  });
});

describe("BeatTracker", () => {
  /** Feed onsets at an exact tempo. */
  function feed(tracker: BeatTracker, bpm: number, beats: number, start = 0): number {
    const period = 60 / bpm;
    let t = start;
    for (let i = 0; i < beats; i++) {
      tracker.onOnset(t);
      t += period;
    }
    return t;
  }

  it("reports nothing until it has evidence", () => {
    // A tracker that confidently reports a wrong tempo is worse than one
    // that reports none: a visual locked to the wrong BPM drifts visibly,
    // which reads as broken.
    const tracker = new BeatTracker();
    expect(tracker.state(0).bpm).toBeNull();

    tracker.onOnset(0);
    tracker.onOnset(0.5);
    expect(tracker.state(0.5).bpm).toBeNull();
  });

  it("finds a steady tempo", () => {
    const tracker = new BeatTracker();
    const end = feed(tracker, 120, 16);
    const state = tracker.state(end);

    expect(state.bpm).not.toBeNull();
    expect(state.bpm!).toBeCloseTo(120, 0);
    expect(state.confidence).toBeGreaterThan(0.5);
  });

  it("finds tempos across the musical range", () => {
    for (const bpm of [70, 100, 128, 174]) {
      const tracker = new BeatTracker();
      const end = feed(tracker, bpm, 20);
      const found = tracker.state(end).bpm;
      expect(found, `failed at ${bpm} bpm`).not.toBeNull();
      // Within one histogram bucket (20 ms), which at 174 bpm is ~10 bpm.
      expect(Math.abs(found! - bpm) / bpm).toBeLessThan(0.1);
    }
  });

  it("puts phase near zero on the beat", () => {
    const tracker = new BeatTracker();
    const end = feed(tracker, 120, 16);

    const onBeat = tracker.state(end).phase;
    expect(Math.min(onBeat, 1 - onBeat)).toBeLessThan(0.1);
  });

  it("advances phase through the beat", () => {
    const tracker = new BeatTracker();
    const end = feed(tracker, 120, 16);
    const period = 0.5;

    const quarter = tracker.state(end + period * 0.25).phase;
    const half = tracker.state(end + period * 0.5).phase;

    expect(quarter).toBeGreaterThan(0.15);
    expect(quarter).toBeLessThan(0.35);
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
  });

  it("stays in [0, 1) even when queried before the anchor", () => {
    // Happens on the frame an onset re-anchors: the modulo can go negative.
    const tracker = new BeatTracker();
    const end = feed(tracker, 120, 16);
    const phase = tracker.state(end - 0.1).phase;
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(1);
  });

  it("reports low confidence on onsets with no pulse", () => {
    // Music with no clear beat should produce a flat histogram and an
    // honest "not sure", not a confident wrong answer.
    const tracker = new BeatTracker();
    let t = 0;
    let seed = 7;
    for (let i = 0; i < 40; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      t += 0.35 + (seed / 0x7fffffff) * 0.6;
      tracker.onOnset(t);
    }
    expect(tracker.state(t).confidence).toBeLessThan(0.55);
  });

  it("ignores gaps outside the musical range", () => {
    // A 10-second gap is not a 6 bpm tempo; it is a pause.
    const tracker = new BeatTracker();
    tracker.onOnset(0);
    tracker.onOnset(10);
    tracker.onOnset(20);
    expect(tracker.state(20).bpm).toBeNull();
  });

  it("prefers an external tempo over its own estimate", () => {
    // A MIDI clock is not an estimate, and should win.
    const tracker = new BeatTracker();
    feed(tracker, 120, 16);
    tracker.setTempo(174, 100);

    const state = tracker.state(100);
    expect(state.bpm).toBeCloseTo(174, 5);
    expect(state.confidence).toBe(1);
    expect(state.phase).toBeCloseTo(0, 5);
  });

  it("forgets everything on reset", () => {
    const tracker = new BeatTracker();
    const end = feed(tracker, 120, 16);
    expect(tracker.state(end).bpm).not.toBeNull();
    tracker.reset();
    expect(tracker.state(end).bpm).toBeNull();
  });
});
