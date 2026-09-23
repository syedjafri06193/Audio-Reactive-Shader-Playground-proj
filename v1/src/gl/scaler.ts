/**
 * Adaptive resolution scaling.
 *
 * A shader that runs at 60 fps on a desktop GPU can run at 12 fps on an
 * integrated one, and the honest answer for a live-visuals tool is to render
 * fewer pixels rather than to drop frames. Everything here is about *when*
 * to change the scale, which is much harder than deciding by how much.
 *
 * Three decisions, each of which is the opposite of the obvious one:
 *
 * 1. **p90, not mean.** A mean frame time hides exactly the problem being
 *    measured. Nine good frames and one 40 ms frame average to a
 *    comfortable 13 ms, while what the viewer sees is a stutter every
 *    tenth frame. The tail is the symptom.
 *
 * 2. **Asymmetric rates.** Drop resolution quickly and raise it slowly. The
 *    cost of being wrong is asymmetric: rendering too small for another
 *    second is a slight softness nobody notices, while oscillating between
 *    two scales produces a visible pulsing that everybody does.
 *
 * 3. **Hysteresis with a dead band.** Without a gap between the "too slow"
 *    and "could be sharper" thresholds, a shader that sits exactly at
 *    budget flips scale every window forever.
 */

export interface ScalerOptions {
  /** Target frame time in ms. 16.7 for 60 fps. */
  targetMs?: number;
  /**
   * Only scale up when p90 is comfortably under budget. The gap between
   * this and `targetMs` is the dead band that stops the oscillation.
   */
  comfortableMs?: number;
  /** Never render below this fraction of the canvas. */
  minScale?: number;
  maxScale?: number;
  /** How many frames feed each decision. ~0.5 s at 60 fps. */
  windowFrames?: number;
  /** Multiplier applied when over budget. */
  downStep?: number;
  /** Multiplier applied when comfortably under. Deliberately gentler. */
  upStep?: number;
  /**
   * Frames to ignore after a scale change. Reallocating framebuffers costs
   * a frame or two, and measuring those would immediately trigger another
   * drop — a feedback loop that walks straight to `minScale`.
   */
  settleFrames?: number;
}

export interface ScalerDecision {
  scale: number;
  changed: boolean;
  /** p90 frame time over the last window, or null before the first one. */
  p90: number | null;
  reason: "over-budget" | "headroom" | "steady" | "measuring" | "settling";
}

const DEFAULTS = {
  targetMs: 16.7,
  comfortableMs: 11,
  minScale: 0.35,
  maxScale: 1,
  windowFrames: 30,
  downStep: 0.8,
  upStep: 1.08,
  settleFrames: 10,
} as const;

export class ResolutionScaler {
  private readonly opts: Required<ScalerOptions>;
  private readonly samples: Float32Array;
  private readonly scratch: Float32Array;
  private count = 0;
  private settling = 0;
  private scale: number;

  constructor(options: ScalerOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.samples = new Float32Array(this.opts.windowFrames);
    this.scratch = new Float32Array(this.opts.windowFrames);
    this.scale = this.opts.maxScale;
  }

  get current(): number {
    return this.scale;
  }

  /**
   * Feed one frame's GPU-side duration and get the scale to render at next.
   *
   * @param frameMs how long the last frame took. Prefer a timer query
   *   (`EXT_disjoint_timer_query_webgl2`) where it exists; `performance.now()`
   *   deltas include compositor and rAF scheduling jitter, which is not
   *   something rendering fewer pixels can fix.
   */
  push(frameMs: number): ScalerDecision {
    // A hidden tab throttles rAF to about 1 Hz while the audio keeps
    // running. Those 1000 ms "frames" are not a rendering problem, and
    // feeding them in would drive the scale to the floor and leave it
    // there when the user came back.
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 200) {
      return { scale: this.scale, changed: false, p90: null, reason: "measuring" };
    }

    if (this.settling > 0) {
      this.settling--;
      return { scale: this.scale, changed: false, p90: null, reason: "settling" };
    }

    this.samples[this.count++] = frameMs;
    if (this.count < this.opts.windowFrames) {
      return { scale: this.scale, changed: false, p90: null, reason: "measuring" };
    }

    const p90 = this.percentile(0.9);
    this.count = 0;

    if (p90 > this.opts.targetMs) {
      return this.retarget(this.scale * this.opts.downStep, p90, "over-budget");
    }
    if (p90 < this.opts.comfortableMs && this.scale < this.opts.maxScale) {
      return this.retarget(this.scale * this.opts.upStep, p90, "headroom");
    }
    return { scale: this.scale, changed: false, p90, reason: "steady" };
  }

  private retarget(want: number, p90: number, reason: ScalerDecision["reason"]): ScalerDecision {
    const next = Math.min(this.opts.maxScale, Math.max(this.opts.minScale, want));

    // Already at the rail. Reporting `changed` here would make the caller
    // reallocate framebuffers to the same size every window.
    if (Math.abs(next - this.scale) < 1e-4) {
      return { scale: this.scale, changed: false, p90, reason: "steady" };
    }

    this.scale = next;
    this.settling = this.opts.settleFrames;
    return { scale: next, changed: true, p90, reason };
  }

  /** Nearest-rank percentile over the current window. */
  private percentile(q: number): number {
    const n = this.opts.windowFrames;
    const s = this.scratch.subarray(0, n);
    s.set(this.samples.subarray(0, n));
    s.sort();
    return s[Math.min(n - 1, Math.floor(q * n))];
  }

  /**
   * Convert the scale into a pixel size.
   *
   * Rounded to even numbers. Odd framebuffer dimensions break half-pixel
   * offsets in blur and feedback passes, and the artefact — a one-pixel
   * drift per frame — is very hard to trace back to here.
   */
  sizeFor(cssWidth: number, cssHeight: number, dpr: number): { width: number; height: number } {
    const even = (v: number) => Math.max(2, Math.round((v * this.scale * dpr) / 2) * 2);
    return { width: even(cssWidth), height: even(cssHeight) };
  }

  /** Pin the scale, e.g. when the user turns adaptation off. */
  set(scale: number): void {
    this.scale = Math.min(this.opts.maxScale, Math.max(this.opts.minScale, scale));
    this.count = 0;
    this.settling = this.opts.settleFrames;
  }

  reset(): void {
    this.scale = this.opts.maxScale;
    this.count = 0;
    this.settling = 0;
  }
}
