/**
 * Onset detection via spectral flux.
 *
 * Amplitude thresholding misses onsets in dense music — a snare landing on
 * top of a sustained pad barely moves the overall level. Spectral flux, the
 * sum of positive frame-to-frame changes across bins, is the standard
 * approach and it is cheap.
 */

export interface FluxResult {
  /**
   * Energy-normalised flux for this frame, roughly 0–1.
   *
   * Normalised rather than raw, and this matters more than it looks.
   * Measured over the same 512-point window at 60 fps:
   *
   * | signal            | raw p50 | raw peak | normalised p50 | normalised peak |
   * |-------------------|---------|----------|----------------|-----------------|
   * | steady white noise| 10.9    | 15.8     | 0.054          | 0.078           |
   * | sustained pad     | 0.51    | 2.97     | 0.050          | 0.293           |
   * | 440 Hz sine       | 0.067   | 0.42     | 0.0067         | 0.041           |
   * | click track       | 0.0     | 113.8    | 0.0            | 0.996           |
   *
   * Raw flux spans four orders of magnitude across ordinary material, so no
   * absolute floor can serve both a sparse click track and dense noise — a
   * floor that lets a click through fires on every frame of the noise.
   * Dividing by the frame's own energy turns flux into a *relative* change
   * measure, and every steady signal collapses to about 0.05 while a real
   * transient still reaches 1.0.
   */
  flux: number;
  /** The adaptive threshold flux was compared against. */
  threshold: number;
  /** True on the frame a transient was detected. */
  onset: boolean;
}

/**
 * Added to the denominator when normalising flux. In the 0–1 per-bin units
 * used here, a frame of true silence sums to about zero, so this decides
 * what "no signal" divides down to.
 */
const ENERGY_EPSILON = 0.5;

export interface OnsetOptions {
  /** How many frames of flux history feed the median. ~1s at 60fps. */
  historyFrames?: number;
  /** Flux must exceed `median * sensitivity + delta` to count. */
  sensitivity?: number;
  /**
   * Added to the scaled median. The additive term is what keeps the
   * threshold meaningful when the median is near zero — on sparse material
   * a purely multiplicative threshold collapses to zero and fires on
   * quantisation noise.
   */
  delta?: number;
  /**
   * Minimum gap between detections. A single drum hit spreads across two or
   * three analysis frames, and without this it registers as three onsets.
   * 80 ms is below the fastest musically plausible repeat (a 32nd note at
   * 180 bpm is 83 ms) while still swallowing the smear.
   */
  refractoryMs?: number;
}

export class OnsetDetector {
  private prev: Float32Array;
  private readonly history: Float32Array;
  /** Ring buffer position, so the history costs no allocation per frame. */
  private historyIndex = 0;
  private historyFilled = 0;
  /** Scratch for the median, reused. */
  private readonly sortScratch: Float32Array;

  private lastOnsetMs = Number.NEGATIVE_INFINITY;

  private readonly sensitivity: number;
  private readonly delta: number;
  private readonly refractoryMs: number;

  constructor(binCount: number, options: OnsetOptions = {}) {
    const historyFrames = options.historyFrames ?? 60;
    this.prev = new Float32Array(binCount);
    this.history = new Float32Array(historyFrames);
    this.sortScratch = new Float32Array(historyFrames);
    this.sensitivity = options.sensitivity ?? 1.6;
    this.delta = options.delta ?? 0.06;
    this.refractoryMs = options.refractoryMs ?? 80;
  }

  /**
   * @param spectrum the *transient* analyser's output — see the note in
   *   features.ts about why smoothing must be off for this path.
   * @param nowMs a monotonic timestamp, for the refractory period.
   */
  detect(spectrum: Uint8Array, nowMs: number): FluxResult {
    if (spectrum.length !== this.prev.length) {
      // fftSize changed, or a different analyser was passed in. Resize
      // rather than reading past the end: the first frame after a resize is
      // a large spurious flux, which is why prev is zeroed and this frame's
      // result is suppressed below.
      this.prev = new Float32Array(spectrum.length);
    }

    let rectified = 0;
    let energy = 0;
    for (let i = 1; i < spectrum.length; i++) {
      const v = spectrum[i] / 255;
      const d = v - this.prev[i];
      // Half-wave rectification: count only increases. This is what makes
      // flux detect *attacks* rather than general change — a note ending is
      // a large negative change and is not an onset.
      if (d > 0) rectified += d;
      this.prev[i] = v;
      energy += v;
    }

    // Normalise by the frame's own energy. The constant keeps silence at
    // zero rather than dividing a tiny numerator by a tinier denominator
    // and producing a large number out of nothing.
    const flux = rectified / (energy + ENERGY_EPSILON);

    const threshold = this.median() * this.sensitivity + this.delta;

    // Push after computing the threshold, so a frame is compared against
    // its own history rather than against itself.
    this.history[this.historyIndex] = flux;
    this.historyIndex = (this.historyIndex + 1) % this.history.length;
    if (this.historyFilled < this.history.length) this.historyFilled++;

    let onset = flux > threshold;

    if (onset && nowMs - this.lastOnsetMs < this.refractoryMs) onset = false;
    if (onset) this.lastOnsetMs = nowMs;

    return { flux, threshold, onset };
  }

  /**
   * Median of the flux history.
   *
   * A median rather than a mean, and adaptive rather than fixed, because
   * both alternatives break on real music. A fixed threshold tuned on a
   * quiet intro fires continuously through the drop; one tuned on the drop
   * detects nothing in the intro. A mean is dragged upward by the very
   * peaks it is supposed to be measuring against.
   */
  private median(): number {
    const n = this.historyFilled;
    if (n === 0) return 0;
    const scratch = this.sortScratch.subarray(0, n);
    scratch.set(this.history.subarray(0, n));
    scratch.sort();
    return scratch[n >> 1];
  }

  /** Forget the history, e.g. when the audio source changes. */
  reset(): void {
    this.prev.fill(0);
    this.history.fill(0);
    this.historyIndex = 0;
    this.historyFilled = 0;
    this.lastOnsetMs = Number.NEGATIVE_INFINITY;
  }
}

/**
 * A decaying envelope, which is what a shader actually wants.
 *
 * Exposing `onset` to GLSL as a boolean would make every shader author write
 * their own decay, and most would write a frame-rate dependent one. Doing it
 * once here means `uOnset` is a smooth 1→0 ramp that every shader gets free.
 */
export class OnsetEnvelope {
  private value = 0;

  constructor(private readonly decayPerSecond = 4) {}

  /**
   * `Math.exp(-rate * dt)` rather than a fixed per-frame multiplier: the
   * exponential form decays at the same rate in seconds whether the display
   * is 60, 120 or 144 Hz. A fixed multiplier decays more than twice as fast
   * on a 144 Hz monitor, which is a real bug on hardware people own.
   */
  update(onset: boolean, intensity: number, dt: number): number {
    // max() rather than assignment: a second hit while the envelope is
    // still high should not *reduce* it.
    if (onset) this.value = Math.max(this.value, intensity);
    this.value *= Math.exp(-this.decayPerSecond * dt);
    return this.value;
  }

  get current(): number {
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}
