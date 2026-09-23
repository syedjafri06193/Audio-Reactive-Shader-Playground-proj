/**
 * Synthetic audio with known content, and a real FFT to analyse it with.
 *
 * The design document suggests `OfflineAudioContext` for this, which is the
 * right answer in a browser. These tests run in Node, where there is no Web
 * Audio at all — so the FFT is implemented here.
 *
 * That turns out to be better rather than worse for the property under
 * test. The claim being verified is *"a 60 Hz sine lands in the bass band
 * and not the treble band"*, and that claim is about the band table's
 * arithmetic, not about the browser's FFT. Computing the spectrum here
 * means the test fails when the band mapping is wrong and passes when it is
 * right, with nothing in between that could mask either.
 */

/** Radix-2 Cooley–Tukey FFT, in place, on separate real and imaginary parts. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length) throw new Error("fft: re and im must be the same length");
  if ((n & (n - 1)) !== 0) throw new Error(`fft: length must be a power of two, got ${n}`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Hann window, which is what AnalyserNode applies before its FFT. */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

export interface SpectrumOptions {
  fftSize?: number;
  sampleRate?: number;
  /** Where in the signal to take the window from. */
  offset?: number;
  /** dB floor, matching AnalyserNode's default minDecibels. */
  minDb?: number;
  /** dB ceiling, matching AnalyserNode's default maxDecibels. */
  maxDb?: number;
}

/**
 * Compute a byte spectrum the way `AnalyserNode.getByteFrequencyData` does:
 * Hann window, FFT, magnitude, convert to dB, then scale the range
 * [minDecibels, maxDecibels] onto 0–255 and clamp.
 *
 * Matching the byte conversion matters. The band code divides by 255 and
 * treats the result as a 0–1 energy, so a test that fed it raw linear
 * magnitudes would be exercising different arithmetic from production.
 */
export function byteSpectrum(samples: Float64Array, options: SpectrumOptions = {}): Uint8Array {
  const fftSize = options.fftSize ?? 2048;
  const offset = options.offset ?? 0;
  const minDb = options.minDb ?? -100;
  const maxDb = options.maxDb ?? -30;

  // Refuse a window that runs past the end rather than zero-padding it.
  // Silent zero-padding is a trap: the spectrum comes back all-zero, every
  // assertion about band content fails, and the failure points at the band
  // code rather than at the fixture that was asked for a window it did not
  // have. This exact mistake cost a debugging session.
  if (offset + fftSize > samples.length) {
    throw new Error(
      `byteSpectrum: window [${offset}, ${offset + fftSize}) runs past the ` +
        `end of a ${samples.length}-sample signal ` +
        `(${(samples.length / SAMPLE_RATE).toFixed(2)}s). Generate a longer ` +
        `fixture or use a smaller offset.`,
    );
  }

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const w = hann(fftSize);

  for (let i = 0; i < fftSize; i++) {
    re[i] = samples[offset + i] * w[i];
  }

  fft(re, im);

  const binCount = fftSize / 2;
  const out = new Uint8Array(binCount);
  for (let i = 0; i < binCount; i++) {
    // Normalise by fftSize so the magnitude of a full-scale sine is
    // independent of the window length.
    const mag = Math.hypot(re[i], im[i]) / fftSize;
    const db = 20 * Math.log10(Math.max(mag, 1e-12));
    const scaled = ((db - minDb) / (maxDb - minDb)) * 255;
    out[i] = Math.max(0, Math.min(255, Math.round(scaled)));
  }
  return out;
}

// ------------------------------------------------------------- generators

export const SAMPLE_RATE = 48_000;

/** A pure sine at `hz`. */
export function sine(hz: number, seconds: number, amplitude = 0.8, sampleRate = SAMPLE_RATE): Float64Array {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/** Several sines summed, for testing that bands separate. */
export function chord(hzs: number[], seconds: number, amplitude = 0.4): Float64Array {
  const n = Math.floor(seconds * SAMPLE_RATE);
  const out = new Float64Array(n);
  for (const hz of hzs) {
    for (let i = 0; i < n; i++) {
      out[i] += amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
    }
  }
  return out;
}

/** Deterministic white noise. Seeded, so a failure is reproducible. */
export function noise(seconds: number, amplitude = 0.5, seed = 12345): Float64Array {
  const n = Math.floor(seconds * SAMPLE_RATE);
  const out = new Float64Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * amplitude;
  }
  return out;
}

/**
 * Band-limited noise: energy spread across a frequency range.
 *
 * The realistic fixture, and the one the band magnitudes should be judged
 * against. A pure sine occupies three or four bins, so under the mean that
 * `readBands` deliberately takes it reads *low* in a wide band — which is
 * the behaviour that stops treble dominating, not a bug. Real instruments
 * are broadband, so this is what production actually sees.
 *
 * Built as a sum of sines at logarithmically spaced frequencies with
 * decorrelated phases, which is cheap and avoids needing a filter.
 */
export function bandNoise(
  loHz: number,
  hiHz: number,
  seconds: number,
  amplitude = 0.8,
  partials = 60,
): Float64Array {
  const n = Math.floor(seconds * SAMPLE_RATE);
  const out = new Float64Array(n);
  const logLo = Math.log2(loHz);
  const logHi = Math.log2(hiHz);

  for (let p = 0; p < partials; p++) {
    const hz = 2 ** (logLo + ((logHi - logLo) * (p + 0.5)) / partials);
    // Deterministic but decorrelated: without varying phase every partial
    // peaks together and the sum clips into a periodic impulse train.
    const phase = (p * 2.399963) % (2 * Math.PI);
    for (let i = 0; i < n; i++) {
      out[i] += Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE + phase);
    }
  }

  // Normalise to the requested peak, so amplitude means the same thing
  // here as it does for sine().
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) {
    const scale = amplitude / peak;
    for (let i = 0; i < n; i++) out[i] *= scale;
  }
  return out;
}

export function silence(seconds: number): Float64Array {
  return new Float64Array(Math.floor(seconds * SAMPLE_RATE));
}

export interface ClickTrackOptions {
  bpm: number;
  bars: number;
  beatsPerBar?: number;
  /** Click duration. Short, so onsets are unambiguous. */
  clickMs?: number;
}

export interface ClickTrack {
  samples: Float64Array;
  /** Sample offsets of each click, for asserting detection accuracy. */
  clickOffsets: number[];
  beatSeconds: number;
}

/**
 * A click track: an exponentially decaying burst of noise on every beat.
 *
 * Noise rather than a sine, because a click has to excite many bins at once
 * for spectral flux to see it. A single-frequency tick moves one bin, and a
 * detector that fires on that would be an amplitude detector wearing a flux
 * detector's clothes.
 */
export function clickTrack(options: ClickTrackOptions): ClickTrack {
  const { bpm, bars, beatsPerBar = 4, clickMs = 8 } = options;
  const beatSeconds = 60 / bpm;
  const totalBeats = bars * beatsPerBar;
  const n = Math.ceil((totalBeats + 1) * beatSeconds * SAMPLE_RATE);

  const samples = new Float64Array(n);
  const clickOffsets: number[] = [];
  const clickSamples = Math.floor((clickMs / 1000) * SAMPLE_RATE);
  const burst = noise(clickMs / 1000, 1.0, 777);

  for (let b = 0; b < totalBeats; b++) {
    const start = Math.floor(b * beatSeconds * SAMPLE_RATE);
    clickOffsets.push(start);
    for (let i = 0; i < clickSamples && start + i < n; i++) {
      // Exponential decay, so the click has a sharp attack and a short
      // tail, which is what an onset detector is supposed to find.
      samples[start + i] += burst[i] * Math.exp((-8 * i) / clickSamples);
    }
  }

  return { samples, clickOffsets, beatSeconds };
}

/**
 * Walk a signal in analysis frames, as the render loop does.
 *
 * `hopSize` is the distance between successive analyses. In the browser
 * this is set by the frame rate rather than chosen — at 60 fps and 48 kHz
 * it is 800 samples — so the default reflects that.
 */
export function* frames(
  samples: Float64Array,
  fftSize: number,
  hopSize = 800,
  options: SpectrumOptions = {},
): Generator<{ spectrum: Uint8Array; timeSeconds: number; offset: number }> {
  for (let offset = 0; offset + fftSize <= samples.length; offset += hopSize) {
    yield {
      spectrum: byteSpectrum(samples, { ...options, fftSize, offset }),
      // The time the window *ends*, which is the earliest moment its
      // contents could possibly be known. Using the window's start would
      // flatter every latency measurement by the window length.
      timeSeconds: (offset + fftSize) / SAMPLE_RATE,
      offset,
    };
  }
}
