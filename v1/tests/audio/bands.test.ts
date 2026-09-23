import { describe, expect, it } from "vitest";

import {
  MUSICAL_BANDS,
  buildLogBands,
  buildMusicalBands,
  normalizeCentroid,
  readBands,
  readMusicalBands,
  spectralCentroid,
} from "../../src/audio/bands.js";
import { SAMPLE_RATE, bandNoise, byteSpectrum, noise, sine } from "./fixtures.js";

const FFT_SIZE = 4096;
const BIN_COUNT = FFT_SIZE / 2;
const BIN_HZ = SAMPLE_RATE / 2 / BIN_COUNT;

/** One window, taken past the signal's onset so it sees the steady state. */
function spectrumOf(samples: Float64Array): Uint8Array {
  return byteSpectrum(samples, { fftSize: FFT_SIZE, offset: FFT_SIZE });
}

function musical(samples: Float64Array) {
  const table = buildMusicalBands(BIN_COUNT, SAMPLE_RATE);
  const out = { sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0 };
  return readMusicalBands(spectrumOf(samples), table, out);
}

describe("the problem this file exists to solve", () => {
  it("shows how little of a linear spectrum covers the musical range", () => {
    // Not a test of our code — a test of the premise. If this ever stops
    // being true, the whole log-banding apparatus is unnecessary.
    const binHz = SAMPLE_RATE / 2 / 1024; // fftSize 2048
    const bassBins = Math.ceil(250 / binHz) - Math.floor(20 / binHz);
    const airBins = 1024 - Math.ceil(6000 / binHz);

    expect(bassBins).toBeLessThan(12);
    expect(airBins / 1024).toBeGreaterThan(0.7);
  });
});

describe("buildLogBands", () => {
  it("never includes bin 0, which is DC and not music", () => {
    // Bin 0 carries no musical information but can be large — a biased ADC
    // or a DC-coupled input puts real energy there — and it sits right next
    // to the bass band it would swamp.
    const bands = buildLogBands(BIN_COUNT, SAMPLE_RATE, 64);
    for (const b of bands) expect(b.loBin).toBeGreaterThanOrEqual(1);
  });

  it("spaces band centres logarithmically, not linearly", () => {
    const bands = buildLogBands(BIN_COUNT, SAMPLE_RATE, 32, 30, 16_000);

    // Each centre should be a near-constant ratio above the last. A linear
    // mapping would give a constant *difference* instead.
    const ratios: number[] = [];
    for (let i = 1; i < bands.length; i++) {
      ratios.push(bands[i].centerHz / bands[i - 1].centerHz);
    }
    const first = ratios[0];
    for (const r of ratios) expect(r).toBeCloseTo(first, 4);
  });

  it("gives the bass register as many bands as the treble", () => {
    // The entire point. On a linear mapping, 20–250 Hz gets ~1% of the
    // array; here it should get roughly its share of the octaves.
    const bands = buildLogBands(BIN_COUNT, SAMPLE_RATE, 64, 30, 16_000);
    const low = bands.filter((b) => b.centerHz < 250).length;
    const high = bands.filter((b) => b.centerHz > 4000).length;

    expect(low).toBeGreaterThan(10);
    // 30–250 Hz is ~3 octaves; 4–16 kHz is 2. So low should have *more*.
    expect(low).toBeGreaterThan(high);
  });

  it("clamps the top band to Nyquist", () => {
    // Asking for bands above Nyquist would index past the end of the array,
    // which reads as silence and looks like a shader bug.
    const bands = buildLogBands(BIN_COUNT, SAMPLE_RATE, 16, 30, 96_000);
    for (const b of bands) {
      expect(b.hiBin).toBeLessThanOrEqual(BIN_COUNT - 1);
      expect(b.loBin).toBeLessThanOrEqual(b.hiBin);
    }
  });

  it("collapses sub-bin bands to a single bin rather than an empty range", () => {
    // At the bottom of the spectrum several log bands genuinely map to the
    // same bin. That is a real resolution limit; what matters is that the
    // range stays valid.
    const bands = buildLogBands(BIN_COUNT, SAMPLE_RATE, 256, 30, 16_000);
    for (const b of bands) expect(b.hiBin).toBeGreaterThanOrEqual(b.loBin);
  });

  it("rejects impossible arguments instead of producing a broken table", () => {
    expect(() => buildLogBands(1, SAMPLE_RATE, 8)).toThrow();
    expect(() => buildLogBands(BIN_COUNT, SAMPLE_RATE, 0)).toThrow();
    expect(() => buildLogBands(BIN_COUNT, SAMPLE_RATE, 8, 0)).toThrow();
  });
});

describe("readBands", () => {
  it("averages rather than sums, so wide bands do not dominate", () => {
    // The detail that decides whether the result is musical. A log band near
    // the top spans hundreds of bins and one near the bottom spans one, so
    // summing makes treble win by construction regardless of the music.
    const bands = buildLogBands(BIN_COUNT, SAMPLE_RATE, 32, 30, 16_000);
    const out = new Float32Array(bands.length);

    // A flat spectrum: every bin at the same value.
    const flat = new Uint8Array(BIN_COUNT).fill(128);
    readBands(flat, bands, out);

    // With a mean, every band reads the same regardless of its width.
    for (const v of out) expect(v).toBeCloseTo(128 / 255, 5);
  });

  it("refuses a mismatched output array rather than writing past the end", () => {
    const bands = buildLogBands(BIN_COUNT, SAMPLE_RATE, 32);
    expect(() => readBands(new Uint8Array(BIN_COUNT), bands, new Float32Array(8))).toThrow();
  });
});

describe("musical bands, against real synthesized audio", () => {
  const names = Object.keys(MUSICAL_BANDS);

  /** Which band read highest. */
  function loudestBand(f: Record<string, number>): string {
    return names.reduce((a, b) => (f[a] > f[b] ? a : b));
  }

  it("puts a 100 Hz sine in bass, not treble", () => {
    const f = musical(sine(100, 1.0)) as Record<string, number>;
    expect(loudestBand(f)).toBe("bass");
    expect(f.treble).toBeLessThan(0.02);
  });

  it("splits a boundary frequency between the two bands that share it", () => {
    // 60 Hz is exactly the sub/bass boundary, so it lands in both — and
    // because `sub` is the narrower band, the mean puts *more* of it there.
    //
    // Worth pinning down because the design document's own example test is
    // "bass responds to a 60 Hz sine", which is ambiguous for this reason.
    // The bands are defined by how people talk about music, not by a
    // partition, and adjacent bands overlapping at their shared edge is the
    // correct behaviour: a 60 Hz kick genuinely is both sub and bass.
    const f = musical(sine(60, 1.0)) as Record<string, number>;
    expect(f.sub).toBeGreaterThan(0.05);
    expect(f.bass).toBeGreaterThan(0.05);
    expect(f.mid).toBeLessThan(0.02);
  });

  it("puts a 10 kHz sine in treble, not bass", () => {
    const f = musical(sine(10_000, 1.0)) as Record<string, number>;
    expect(loudestBand(f)).toBe("treble");
    expect(f.bass).toBeLessThan(0.02);
  });

  it("puts a 1 kHz sine in mid", () => {
    const f = musical(sine(1000, 1.0)) as Record<string, number>;
    expect(loudestBand(f)).toBe("mid");
    expect(f.sub).toBeLessThan(0.02);
    expect(f.treble).toBeLessThan(0.02);
  });

  it("reads a pure sine low in a wide band, which is the mean working", () => {
    // Not a defect. A sine occupies three or four bins; the mid band spans
    // over a hundred. Under a *sum* this would read high and treble — which
    // spans five hundred bins — would read higher still on any input at
    // all, which is precisely the dominance the mean exists to prevent.
    const f = musical(sine(1000, 1.0)) as Record<string, number>;
    expect(f.mid).toBeLessThan(0.3);
    expect(f.mid).toBeGreaterThan(0.02);
  });

  it("reads broadband content high, because real music is broadband", () => {
    const f = musical(bandNoise(500, 2000, 1.0)) as Record<string, number>;
    expect(loudestBand(f)).toBe("mid");
    expect(f.mid).toBeGreaterThan(0.6);
  });

  it("does not let treble dominate on a flat broadband signal", () => {
    // The failure mode a sum would produce: treble spans ~500 bins and bass
    // spans ~8, so summing makes treble win regardless of the music.
    const f = musical(noise(1.0)) as Record<string, number>;
    const spread = Math.max(...names.map((n) => f[n])) - Math.min(...names.map((n) => f[n]));
    expect(spread).toBeLessThan(0.5);
  });

  it("separates a bass line from a cymbal in the same signal", () => {
    // The case that matters: real music has both at once, and a visualizer
    // that cannot tell them apart pumps uniformly. Both parts are
    // broadband, because both are in reality — a bass note has harmonics
    // and a cymbal is nearly noise.
    const bass = bandNoise(60, 180, 1.0, 0.5);
    const cymbal = bandNoise(5000, 14_000, 1.0, 0.5);
    const mixed = new Float64Array(bass.length);
    for (let i = 0; i < mixed.length; i++) mixed[i] = bass[i] + cymbal[i];

    const f = musical(mixed) as Record<string, number>;
    // Both present and comfortably above the middle, which is where the
    // point lies. The absolute levels differ because summing two signals
    // halves each one's share of the available headroom, and because the
    // cymbal's 5–14 kHz spans only part of the 4–16 kHz treble band.
    expect(f.bass).toBeGreaterThan(0.15);
    expect(f.treble).toBeGreaterThan(0.15);
    expect(f.mid).toBeLessThan(Math.min(f.bass, f.treble) * 0.6);
  });

  it("reports near-silence for silence", () => {
    const f = musical(new Float64Array(SAMPLE_RATE));
    for (const v of Object.values(f)) expect(v).toBeLessThan(0.05);
  });

  it("routes every part of the audible range to the band that owns it", () => {
    const expected: Array<[number, string]> = [
      [40, "sub"],
      [120, "bass"],
      [350, "lowMid"],
      [900, "mid"],
      [3000, "highMid"],
      [8000, "treble"],
    ];
    for (const [hz, band] of expected) {
      const f = musical(bandNoise(hz * 0.9, hz * 1.1, 0.5)) as Record<string, number>;
      expect(loudestBand(f), `${hz} Hz went to the wrong band`).toBe(band);
    }
  });
});

describe("spectralCentroid", () => {
  it("tracks the frequency of a sine", () => {
    for (const hz of [200, 1000, 5000]) {
      const c = spectralCentroid(spectrumOf(sine(hz, 0.5)), BIN_HZ);
      // Wide tolerance: the Hann window spreads energy into neighbouring
      // bins and the byte quantisation floor pulls the mean upward. What is
      // being asserted is that it tracks, not that it is exact.
      expect(c).toBeGreaterThan(hz * 0.4);
      expect(c).toBeLessThan(hz * 3 + 2000);
    }
  });

  it("rises when the signal gets brighter", () => {
    // The property that makes it useful: it responds to timbre, not volume.
    const dark = spectralCentroid(spectrumOf(sine(200, 0.5)), BIN_HZ);
    const bright = spectralCentroid(spectrumOf(sine(6000, 0.5)), BIN_HZ);
    expect(bright).toBeGreaterThan(dark);
  });

  it("does not move much when only the volume changes", () => {
    const quiet = spectralCentroid(spectrumOf(sine(1000, 0.5, 0.2)), BIN_HZ);
    const loud = spectralCentroid(spectrumOf(sine(1000, 0.5, 0.9)), BIN_HZ);
    // Louder does raise it a little, because more of the skirt clears the
    // dB floor. It should not double.
    expect(loud / quiet).toBeLessThan(2);
  });

  it("returns 0 for an empty spectrum rather than NaN", () => {
    expect(spectralCentroid(new Uint8Array(BIN_COUNT), BIN_HZ)).toBe(0);
  });

  it("sits high for white noise", () => {
    // Noise has energy everywhere, so the amplitude-weighted mean should be
    // up in the middle of the range rather than near zero.
    const c = spectralCentroid(spectrumOf(noise(0.5)), BIN_HZ);
    expect(c).toBeGreaterThan(2000);
  });
});

describe("normalizeCentroid", () => {
  it("is logarithmic, so the usable range is spread out", () => {
    // A linear normalisation would squash everything below 1 kHz into the
    // bottom eighth of the range.
    const at100 = normalizeCentroid(100);
    const at1k = normalizeCentroid(1000);
    const at8k = normalizeCentroid(8000);

    expect(at100).toBe(0);
    expect(at8k).toBe(1);
    // One decade of the three-ish octaves each way: the midpoint of the
    // log range should be near the middle, not near the bottom.
    expect(at1k).toBeGreaterThan(0.4);
    expect(at1k).toBeLessThan(0.7);
  });

  it("clamps outside its range", () => {
    expect(normalizeCentroid(10)).toBe(0);
    expect(normalizeCentroid(20_000)).toBe(1);
  });
});
