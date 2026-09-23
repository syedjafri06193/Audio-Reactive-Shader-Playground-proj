/**
 * The per-frame audio feature set, and the analyser pair that produces it.
 */

import {
  type Band,
  type MusicalBandName,
  type MusicalBandTable,
  buildLogBands,
  buildMusicalBands,
  normalizeCentroid,
  readBands,
  readMusicalBands,
  spectralCentroid,
} from "./bands.js";
import { BeatTracker, type BeatState } from "./beat.js";
import { OnsetDetector, OnsetEnvelope } from "./onset.js";

/**
 * What a shader gets. Everything is 0–1 unless noted, because a shader
 * author should not have to know the sample rate to use a number.
 */
export interface AudioFeatures {
  // Musically-named bands (bands.ts).
  sub: number;
  bass: number;
  lowMid: number;
  mid: number;
  highMid: number;
  treble: number;

  /** Overall loudness, RMS of the time-domain signal. */
  rms: number;
  /** Peak sample magnitude this frame. Useful for clip indication. */
  peak: number;

  /** Amplitude-weighted mean frequency, in Hz. */
  centroidHz: number;
  /** The same, normalised 0–1 on a log scale — what shaders want. */
  centroid: number;

  /** Raw spectral flux. */
  flux: number;
  /** True on the frame a transient was detected. */
  onset: boolean;
  /** Decaying envelope of onsets — this is what `uOnset` carries. */
  onsetEnvelope: number;

  bpm: number | null;
  beatPhase: number;
  beatConfidence: number;

  /** Log-banded spectrum, 0–1 per band. Uploaded as `uSpectrum`. */
  logSpectrum: Float32Array;
}

export interface AnalyserPairOptions {
  /**
   * Large window: frequency resolution for bands and centroid.
   *
   * 4096 at 48 kHz is 11.7 Hz per bin and an 85 ms window. The window is
   * latency you cannot optimise away — it *is* the measurement — but bass
   * discrimination needs it: musical notes at 40–80 Hz are only a few Hz
   * apart, and at fftSize 1024 they all land in the same bin.
   */
  spectralFftSize?: number;
  /** Heavy smoothing: this path drives sustained motion, so stability wins. */
  spectralSmoothing?: number;
  /**
   * Small window: transient response for onsets.
   *
   * 512 at 48 kHz is a 10.7 ms window. Frequency resolution is poor (94 Hz
   * per bin) and that is fine — flux does not care which bin moved, only
   * that many of them moved upward at once.
   */
  transientFftSize?: number;
  /**
   * **Must be 0.** `smoothingTimeConstant` is an exponential moving average
   * over successive frames, and its entire purpose is to smear sharp
   * changes. The default of 0.8 would destroy exactly the signal onset
   * detection depends on.
   */
  transientSmoothing?: number;
  /** How many log bands to compute for `uSpectrum`. */
  logBandCount?: number;
}

/**
 * Two analysers fed from one source.
 *
 * A single `smoothingTimeConstant` cannot serve both sustained motion and
 * transient response: high enough to keep colours from flickering is high
 * enough to miss every kick. So there are two, and they are read once per
 * frame each.
 */
export class FeatureExtractor {
  readonly spectral: AnalyserNode;
  readonly transient: AnalyserNode;

  // Explicitly non-shared buffers: the AnalyserNode read methods require
  // Uint8Array<ArrayBuffer>, and a bare Uint8Array widens to ArrayBufferLike
  // which includes SharedArrayBuffer.
  private readonly spectrumBytes: Uint8Array<ArrayBuffer>;
  private readonly transientBytes: Uint8Array<ArrayBuffer>;
  private readonly timeBytes: Uint8Array<ArrayBuffer>;

  private readonly logBands: Band[];
  private readonly logSpectrum: Float32Array;
  private readonly musicalTable: MusicalBandTable[];
  private readonly musical: Record<MusicalBandName, number>;

  private readonly onsetDetector: OnsetDetector;
  private readonly onsetEnvelope = new OnsetEnvelope();
  private readonly beatTracker = new BeatTracker();

  private readonly binHz: number;

  /**
   * The feature object is allocated once and mutated in place. Sixty object
   * literals per second is not free, and this one is read by every module
   * downstream.
   */
  private readonly features: AudioFeatures;

  constructor(
    private readonly context: BaseAudioContext,
    source: AudioNode,
    options: AnalyserPairOptions = {},
  ) {
    const spectralFftSize = options.spectralFftSize ?? 4096;
    const transientFftSize = options.transientFftSize ?? 512;
    const logBandCount = options.logBandCount ?? 64;

    this.spectral = context.createAnalyser();
    this.spectral.fftSize = spectralFftSize;
    this.spectral.smoothingTimeConstant = options.spectralSmoothing ?? 0.75;

    this.transient = context.createAnalyser();
    this.transient.fftSize = transientFftSize;
    this.transient.smoothingTimeConstant = options.transientSmoothing ?? 0;

    source.connect(this.spectral);
    source.connect(this.transient);

    this.spectrumBytes = new Uint8Array(this.spectral.frequencyBinCount);
    this.transientBytes = new Uint8Array(this.transient.frequencyBinCount);
    this.timeBytes = new Uint8Array(this.spectral.fftSize);

    this.binHz = context.sampleRate / 2 / this.spectral.frequencyBinCount;

    this.logBands = buildLogBands(
      this.spectral.frequencyBinCount,
      context.sampleRate,
      logBandCount,
    );
    this.logSpectrum = new Float32Array(logBandCount);

    this.musicalTable = buildMusicalBands(this.spectral.frequencyBinCount, context.sampleRate);
    this.musical = {
      sub: 0,
      bass: 0,
      lowMid: 0,
      mid: 0,
      highMid: 0,
      treble: 0,
    };

    this.onsetDetector = new OnsetDetector(this.transient.frequencyBinCount);

    this.features = {
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
      logSpectrum: this.logSpectrum,
    };
  }

  /**
   * Read both analysers and compute everything. Call **once** per frame.
   *
   * Calling `getByteFrequencyData` more than once per frame returns the same
   * data at extra cost and — worse — makes the smoothing state's behaviour
   * hard to reason about, because each call advances the analyser's internal
   * averaging.
   *
   * @param audioTime `AudioContext.currentTime`, for the beat tracker.
   * @param dt clamped frame delta in seconds, for the onset envelope.
   */
  read(audioTime: number, dt: number): AudioFeatures {
    this.spectral.getByteFrequencyData(this.spectrumBytes);
    this.transient.getByteFrequencyData(this.transientBytes);
    this.spectral.getByteTimeDomainData(this.timeBytes);

    readMusicalBands(this.spectrumBytes, this.musicalTable, this.musical);
    this.features.sub = this.musical.sub;
    this.features.bass = this.musical.bass;
    this.features.lowMid = this.musical.lowMid;
    this.features.mid = this.musical.mid;
    this.features.highMid = this.musical.highMid;
    this.features.treble = this.musical.treble;

    readBands(this.spectrumBytes, this.logBands, this.logSpectrum);

    const { rms, peak } = timeDomainLevels(this.timeBytes);
    this.features.rms = rms;
    this.features.peak = peak;

    const centroidHz = spectralCentroid(this.spectrumBytes, this.binHz);
    this.features.centroidHz = centroidHz;
    this.features.centroid = normalizeCentroid(centroidHz);

    // The onset path reads the *transient* analyser. Running it on the
    // smoothed one is the single most common way to build a detector that
    // reports almost nothing and looks like a threshold problem.
    const { flux, onset } = this.onsetDetector.detect(this.transientBytes, audioTime * 1000);
    this.features.flux = flux;
    this.features.onset = onset;

    if (onset) this.beatTracker.onOnset(audioTime);
    // Intensity from the transient band energy rather than the flux itself,
    // so a loud kick gives a bigger flash than a quiet one. Flux measures
    // *change*, which is nearly as large for a quiet hit in silence.
    this.features.onsetEnvelope = this.onsetEnvelope.update(
      onset,
      Math.min(1, this.features.rms * 2 + this.features.bass),
      dt,
    );

    const beat: BeatState = this.beatTracker.state(audioTime);
    this.features.bpm = beat.bpm;
    this.features.beatPhase = beat.phase;
    this.features.beatConfidence = beat.confidence;

    return this.features;
  }

  /** Adopt an external tempo (MIDI clock, or the user typing one). */
  setTempo(bpm: number): void {
    this.beatTracker.setTempo(bpm, this.context.currentTime);
  }

  /** The analysis window, in milliseconds — the latency floor (§3.2). */
  get spectralWindowMs(): number {
    return (this.spectral.fftSize / this.context.sampleRate) * 1000;
  }

  get transientWindowMs(): number {
    return (this.transient.fftSize / this.context.sampleRate) * 1000;
  }

  get bandCount(): number {
    return this.logSpectrum.length;
  }

  reset(): void {
    this.onsetDetector.reset();
    this.onsetEnvelope.reset();
    this.beatTracker.reset();
  }

  dispose(): void {
    this.spectral.disconnect();
    this.transient.disconnect();
  }
}

/**
 * RMS and peak from byte time-domain data.
 *
 * `getByteTimeDomainData` centres on 128, so 0 is -1.0 and 255 is ~+1.0.
 * Forgetting the offset gives an RMS that never drops below ~0.5 and a
 * visualizer that appears to react to silence.
 */
export function timeDomainLevels(time: Uint8Array): { rms: number; peak: number } {
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < time.length; i++) {
    const v = (time[i] - 128) / 128;
    sumSquares += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sumSquares / time.length), peak };
}
