/**
 * Tempo estimation and beat phase.
 *
 * Deliberately modest. Beat tracking done well is a research problem, and a
 * mediocre tracker that confidently reports the wrong tempo is worse than
 * one that reports nothing: a visual locked to a wrong BPM drifts visibly
 * against the music, which reads as broken, whereas an unlocked visual
 * merely reads as unlocked.
 *
 * So this reports `null` until it has real evidence, and exposes a
 * confidence so the UI can say "not sure" rather than guessing. When a MIDI
 * clock is available, prefer it — see midi/clock.ts. It is not an estimate.
 */

export interface BeatState {
  /** Estimated tempo, or null when there is not enough evidence. */
  bpm: number | null;
  /** 0–1 position within the current beat. 0 on the beat. */
  phase: number;
  /** 0–1. Below ~0.3 the estimate should not drive anything visible. */
  confidence: number;
}

/** The musically plausible range. Outside it, an estimate is an artefact. */
const MIN_BPM = 60;
const MAX_BPM = 200;

const MIN_INTERVAL = 60 / MAX_BPM;
const MAX_INTERVAL = 60 / MIN_BPM;

export interface BeatTrackerOptions {
  /** How many inter-onset intervals to keep. */
  historySize?: number;
  /** Width of the histogram bucket, in seconds. */
  bucketSeconds?: number;
  /** Minimum agreeing intervals before reporting a tempo at all. */
  minEvidence?: number;
}

/**
 * Inter-onset-interval histogram.
 *
 * Onsets arrive; the gaps between them are bucketed; the most popular bucket
 * is the beat period. Crude, but it degrades honestly — on music with no
 * clear pulse the histogram stays flat and confidence stays low, which is
 * the correct answer.
 */
export class BeatTracker {
  private readonly intervals: number[] = [];
  private readonly historySize: number;
  private readonly bucketSeconds: number;
  private readonly minEvidence: number;

  private lastOnsetTime: number | null = null;
  /** Audio-clock time of the most recent beat we believe in. */
  private beatAnchor: number | null = null;
  private period: number | null = null;
  private confidence = 0;

  constructor(options: BeatTrackerOptions = {}) {
    this.historySize = options.historySize ?? 48;
    this.bucketSeconds = options.bucketSeconds ?? 0.02;
    this.minEvidence = options.minEvidence ?? 6;
  }

  /**
   * @param audioTime `AudioContext.currentTime`, never `performance.now()`.
   *   The two clocks drift, and a tempo estimate built on the wall clock
   *   slides out of phase with the music over minutes.
   */
  onOnset(audioTime: number): void {
    if (this.lastOnsetTime !== null) {
      const gap = audioTime - this.lastOnsetTime;
      if (gap >= MIN_INTERVAL && gap <= MAX_INTERVAL) {
        this.intervals.push(gap);
        if (this.intervals.length > this.historySize) this.intervals.shift();
        this.estimate();
      }
    }
    this.lastOnsetTime = audioTime;

    // Re-anchor on every onset that lands near where we expected one. This
    // is what keeps phase locked when the tempo is right, and what lets it
    // recover when the estimate was wrong.
    if (this.period !== null) {
      if (this.beatAnchor === null) {
        this.beatAnchor = audioTime;
      } else {
        const sincePhase = ((audioTime - this.beatAnchor) % this.period) / this.period;
        const offBy = Math.min(sincePhase, 1 - sincePhase);
        if (offBy < 0.15) this.beatAnchor = audioTime;
      }
    } else {
      this.beatAnchor = audioTime;
    }
  }

  private estimate(): void {
    if (this.intervals.length < this.minEvidence) {
      this.confidence = 0;
      return;
    }

    const buckets = new Map<number, number>();
    for (const interval of this.intervals) {
      const key = Math.round(interval / this.bucketSeconds);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);

      // Also credit the half and double. A tracker that only counts exact
      // gaps splits its evidence between "every beat" and "every other
      // beat" on music where onsets are not uniform, and then believes
      // neither. Half credit, so a genuine agreement still wins.
      const half = Math.round(interval / 2 / this.bucketSeconds);
      const double = Math.round((interval * 2) / this.bucketSeconds);
      if (half * this.bucketSeconds >= MIN_INTERVAL) {
        buckets.set(half, (buckets.get(half) ?? 0) + 0.5);
      }
      if (double * this.bucketSeconds <= MAX_INTERVAL) {
        buckets.set(double, (buckets.get(double) ?? 0) + 0.5);
      }
    }

    let bestKey = 0;
    let bestCount = 0;
    for (const [key, count] of buckets) {
      if (count > bestCount) {
        bestCount = count;
        bestKey = key;
      }
    }

    const period = bestKey * this.bucketSeconds;
    if (period < MIN_INTERVAL || period > MAX_INTERVAL) {
      this.confidence = 0;
      return;
    }

    this.period = period;
    // Share of the evidence that agrees. A flat histogram — music with no
    // clear pulse — gives a low number, which is the honest answer.
    this.confidence = Math.min(1, bestCount / this.intervals.length);
  }

  /** Current state, evaluated at an audio-clock time. */
  state(audioTime: number): BeatState {
    if (this.period === null || this.beatAnchor === null || this.confidence <= 0) {
      return { bpm: null, phase: 0, confidence: 0 };
    }
    const since = audioTime - this.beatAnchor;
    // The modulo can go negative if the anchor is ahead of the query, which
    // happens on the frame an onset re-anchors.
    const phase = (((since % this.period) + this.period) % this.period) / this.period;
    return { bpm: 60 / this.period, phase, confidence: this.confidence };
  }

  /**
   * Adopt an external tempo — a MIDI clock, or a user typing a number.
   * Always preferable to estimating when it is available.
   */
  setTempo(bpm: number, audioTime: number): void {
    this.period = 60 / bpm;
    this.beatAnchor = audioTime;
    this.confidence = 1;
  }

  reset(): void {
    this.intervals.length = 0;
    this.lastOnsetTime = null;
    this.beatAnchor = null;
    this.period = null;
    this.confidence = 0;
  }
}
