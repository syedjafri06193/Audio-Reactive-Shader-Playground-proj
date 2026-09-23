/**
 * The latency budget, measured rather than assumed.
 *
 * "Reactive" visuals have a real deadline, and the interesting thing about
 * this budget is that most of it is not overhead that better engineering
 * could remove. **The FFT window is the measurement.** Resolving a 40 Hz
 * bass note requires observing at least one cycle of it — 25 ms — and no
 * amount of optimisation changes that. A 4096-point window at 48 kHz is
 * 85 ms of audio, and the analysis result describes the *average* of that
 * window, so it is effectively centred ~43 ms in the past before anything
 * else happens.
 *
 * The other important property is that the tolerance is **asymmetric**.
 * Visuals lagging the music by 50 ms read as tight; visuals *leading* by
 * 50 ms are impossible and would read as wrong even if they were somehow
 * achievable. So every uncertainty here is spent on the lag side.
 */

export interface LatencyReport {
  /** Half the analysis window: the centre of what the FFT describes. */
  analysisMs: number;
  /**
   * The output device's own buffering, from `AudioContext.outputLatency`.
   * Bluetooth headphones add 150–300 ms here and the page cannot fix it;
   * knowing the number is the difference between "the tool is broken" and
   * "the headphones are the problem".
   */
  outputMs: number;
  /** `AudioContext.baseLatency`: the graph's internal buffering. */
  baseMs: number;
  /** One frame at the measured refresh rate. */
  frameMs: number;
  /** Everything that is actually under our control. */
  controllableMs: number;
  /** The whole path, analysis to photons. */
  totalMs: number;
  /** Plain-language assessment for the diagnostics panel. */
  verdict: "tight" | "acceptable" | "loose" | "unusable";
  notes: string[];
}

export interface LatencyInputs {
  sampleRate: number;
  /** The *spectral* analyser's window; the transient one is much shorter. */
  fftSize: number;
  /** `AudioContext.outputLatency`, seconds. Often 0 or undefined. */
  outputLatency?: number;
  /** `AudioContext.baseLatency`, seconds. */
  baseLatency?: number;
  /** Measured frame interval in ms. */
  frameMs?: number;
  /** Whether the source is a file (which can be analysed ahead) or live. */
  canAnalyzeAhead?: boolean;
}

export function measureLatency(inputs: LatencyInputs): LatencyReport {
  const {
    sampleRate,
    fftSize,
    outputLatency = 0,
    baseLatency = 0,
    frameMs = 16.7,
    canAnalyzeAhead = false,
  } = inputs;

  const windowMs = (fftSize / sampleRate) * 1000;
  // Half the window, not the whole one: the FFT result describes the
  // window's centre, not its end.
  const analysisMs = windowMs / 2;
  const outputMs = outputLatency * 1000;
  const baseMs = baseLatency * 1000;

  // What could actually be improved by changing this code. Output latency
  // belongs to the device, and the analysis window belongs to physics.
  const controllableMs = frameMs + baseMs;
  const totalMs = analysisMs + baseMs + frameMs + outputMs;

  const notes: string[] = [];

  notes.push(
    `A ${fftSize}-point window at ${Math.round(sampleRate)} Hz spans ${windowMs.toFixed(1)} ms; ` +
      `its result describes the middle of that, so ${analysisMs.toFixed(1)} ms is inherent to the measurement.`,
  );

  if (outputMs > 100) {
    notes.push(
      `Output latency is ${outputMs.toFixed(0)} ms — typical of Bluetooth audio. ` +
        `The visuals are in sync with the analysis; the sound is what is late, and no setting here can change that.`,
    );
  } else if (outputLatency === 0) {
    // Firefox reports 0 and Safari has historically not implemented it at
    // all, so a zero is "unknown", not "none". Reporting it as zero would
    // understate the budget on exactly the platforms where it matters.
    notes.push(
      "This browser does not report output latency, so the real total is higher than the figure shown — typically by 10–40 ms for wired output.",
    );
  }

  if (canAnalyzeAhead) {
    notes.push(
      "This source is a file, so analysis can run ahead of playback and the analysis window costs nothing. " +
        "Live input cannot do this: the audio does not exist yet.",
    );
  }

  const effective = canAnalyzeAhead ? totalMs - analysisMs : totalMs;

  let verdict: LatencyReport["verdict"];
  if (effective < 60) verdict = "tight";
  else if (effective < 120) verdict = "acceptable";
  else if (effective < 250) verdict = "loose";
  else verdict = "unusable";

  if (verdict === "loose" || verdict === "unusable") {
    notes.push(
      "Reducing the spectral FFT size would cut the analysis latency, at the cost of bass frequency resolution — " +
        "at 1024 points, musical notes between 40 and 80 Hz all land in the same bin.",
    );
  }

  return {
    analysisMs,
    outputMs,
    baseMs,
    frameMs,
    controllableMs,
    totalMs: effective,
    verdict,
    notes,
  };
}

/**
 * Compensation offset for a file source.
 *
 * Only meaningful when the audio is a file: the analyser can be fed from a
 * point ahead of the playhead, so the visuals land on the beat instead of
 * behind it. For live input this is necessarily zero — you cannot analyse
 * audio that has not happened.
 */
export function lookaheadSeconds(report: LatencyReport, canAnalyzeAhead: boolean): number {
  if (!canAnalyzeAhead) return 0;
  // Compensate the parts that are genuinely predictable. Output latency is
  // excluded deliberately: it is often misreported, and over-compensating
  // pushes the visuals *ahead* of the music, which is the one direction
  // that is never acceptable.
  return (report.analysisMs + report.frameMs) / 1000;
}

/** Human-readable summary for the diagnostics panel. */
export function summarizeLatency(report: LatencyReport): string {
  return (
    `${report.totalMs.toFixed(0)} ms (${report.verdict}) — ` +
    `${report.analysisMs.toFixed(0)} ms analysis, ${report.frameMs.toFixed(0)} ms frame, ` +
    `${report.outputMs.toFixed(0)} ms output`
  );
}
