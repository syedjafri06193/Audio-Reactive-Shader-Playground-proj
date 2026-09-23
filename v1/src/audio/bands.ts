/**
 * Frequency band mapping — the finding that matters most in this project.
 *
 * `AnalyserNode.getByteFrequencyData()` returns bins spanning 0 to
 * `sampleRate / 2` **linearly**. Hearing is logarithmic. At fftSize 2048 and
 * 48 kHz that is 1024 bins of 23.4 Hz each, and the consequence is stark:
 *
 * | Range        | Content                       | Bins | Share |
 * |--------------|-------------------------------|------|-------|
 * | 20–250 Hz    | kick, bass — the groove       | ~10  | 1%    |
 * | 250–2000 Hz  | body, vocals, harmony         | ~75  | 7%    |
 * | 2000–6000 Hz | presence, attack              | ~170 | 17%   |
 * | 6000–24000Hz | air, cymbals, mostly nothing  | ~770 | 75%   |
 *
 * Three quarters of the array describes the top octave and a half, where
 * very little perceptual energy lives, while the entire bass register is ten
 * bins. Plot that array as bars directly and you get the classic dead
 * visualizer: a cluster of activity on the far left and a vast field of
 * nearly static noise.
 *
 * Everything here exists to avoid that.
 */

/** One logarithmically-spaced band, resolved to bin indices. */
export interface Band {
  /** First bin, inclusive. Never 0 — see buildLogBands. */
  loBin: number;
  /** Last bin, inclusive. */
  hiBin: number;
  /** Geometric centre of the band in Hz, which is the perceptual centre. */
  centerHz: number;
  /** Nominal edges, for labelling an axis. */
  loHz: number;
  hiHz: number;
}

/**
 * Map linear FFT bins onto perceptually-spaced bands.
 *
 * `fMin` defaults to 30 Hz rather than 20: below about 30 Hz there is
 * usually nothing but rumble and DC leakage, and including it makes the
 * lowest band mostly noise.
 *
 * `fMax` defaults to 16 kHz rather than Nyquist for the same reason at the
 * other end — 16–24 kHz is almost always empty, and giving it bands means
 * giving it screen space.
 */
export function buildLogBands(
  binCount: number,
  sampleRate: number,
  bandCount: number,
  fMin = 30,
  fMax = 16_000,
): Band[] {
  if (binCount < 2) throw new Error(`buildLogBands: binCount must be at least 2, got ${binCount}`);
  if (bandCount < 1) throw new Error(`buildLogBands: bandCount must be at least 1, got ${bandCount}`);
  if (fMin <= 0) throw new Error(`buildLogBands: fMin must be positive, got ${fMin}`);

  const nyquist = sampleRate / 2;
  const binHz = nyquist / binCount;

  // Clamp the top to Nyquist. Asking for bands above it produces bins past
  // the end of the array, which reads as silence and looks like a bug in
  // the shader rather than in the band table.
  const top = Math.min(fMax, nyquist);

  const logMin = Math.log2(fMin);
  const logMax = Math.log2(top);

  const bands: Band[] = [];
  for (let i = 0; i < bandCount; i++) {
    const loHz = 2 ** (logMin + (logMax - logMin) * (i / bandCount));
    const hiHz = 2 ** (logMin + (logMax - logMin) * ((i + 1) / bandCount));

    // Math.max(1, ...) skips bin 0. Bin 0 is the DC offset: it carries no
    // musical information at all, but it can be large — a slightly biased
    // ADC or a DC-coupled input puts real energy there — and it would swamp
    // the bass band that sits right next to it.
    const loBin = Math.max(1, Math.floor(loHz / binHz));
    const hiBin = Math.min(binCount - 1, Math.ceil(hiHz / binHz));

    bands.push({
      loBin,
      // A band narrower than one bin collapses to a single bin rather than
      // an empty range. At the bottom of the spectrum this is a real
      // resolution limit, not a rounding convenience: at 23.4 Hz per bin,
      // several of the lowest log bands genuinely map to the same bin.
      hiBin: Math.max(loBin, hiBin),
      centerHz: Math.sqrt(loHz * hiHz),
      loHz,
      hiHz,
    });
  }
  return bands;
}

/**
 * Read the band energies out of a spectrum.
 *
 * `out` is passed in and reused. A fresh Float32Array per frame is sixty
 * allocations per second of pressure on the collector, and the render loop
 * is exactly where that shows up.
 */
export function readBands(spectrum: Uint8Array, bands: Band[], out: Float32Array): Float32Array {
  if (out.length !== bands.length) {
    throw new Error(`readBands: out has length ${out.length}, expected ${bands.length}`);
  }
  for (let b = 0; b < bands.length; b++) {
    const { loBin, hiBin } = bands[b];
    let sum = 0;
    for (let i = loBin; i <= hiBin; i++) sum += spectrum[i];
    // Mean, not sum. This is the detail that decides whether the result is
    // musical: a log band near the top spans hundreds of bins and one near
    // the bottom spans one, so summing makes treble dominate by
    // construction regardless of what is in the music.
    out[b] = sum / (hiBin - loBin + 1) / 255;
  }
  return out;
}

/**
 * The named musical bands. Most shaders do not want 1024 numbers; they want
 * four or five meaningful scalars, and these are the ones that correspond
 * to how people talk about music.
 */
export const MUSICAL_BANDS = {
  sub: [20, 60], //  the physical thump you feel
  bass: [60, 250], //  kick and bass line — the groove
  lowMid: [250, 500], //  body, warmth
  mid: [500, 2000], //  vocals, melody
  highMid: [2000, 4000], //  presence and attack
  treble: [4000, 16_000], //  air, cymbals
} as const satisfies Record<string, readonly [number, number]>;

export type MusicalBandName = keyof typeof MUSICAL_BANDS;

export const MUSICAL_BAND_NAMES = Object.keys(MUSICAL_BANDS) as MusicalBandName[];

/** A resolved musical band: the Hz range turned into bin indices. */
export interface MusicalBandTable {
  name: MusicalBandName;
  loBin: number;
  hiBin: number;
}

/**
 * Resolve the named bands against a given FFT configuration, once, so the
 * per-frame read is a pair of integer loops and nothing else.
 */
export function buildMusicalBands(binCount: number, sampleRate: number): MusicalBandTable[] {
  const nyquist = sampleRate / 2;
  const binHz = nyquist / binCount;

  return MUSICAL_BAND_NAMES.map((name) => {
    const [lo, hi] = MUSICAL_BANDS[name];
    const loBin = Math.max(1, Math.floor(lo / binHz)); // skip DC
    const hiBin = Math.min(binCount - 1, Math.ceil(hi / binHz));
    return { name, loBin, hiBin: Math.max(loBin, hiBin) };
  });
}

/** Read the named bands. Mean per band, for the reason above. */
export function readMusicalBands(
  spectrum: Uint8Array,
  table: MusicalBandTable[],
  out: Record<MusicalBandName, number>,
): Record<MusicalBandName, number> {
  for (const { name, loBin, hiBin } of table) {
    let sum = 0;
    for (let i = loBin; i <= hiBin; i++) sum += spectrum[i];
    out[name] = sum / (hiBin - loBin + 1) / 255;
  }
  return out;
}

/**
 * The amplitude-weighted mean frequency: a single scalar that tracks
 * perceived brightness.
 *
 * Underrated. Mapping it to hue or sharpness gives a visual that responds to
 * *timbre* rather than just volume, and timbre is where the musical interest
 * is — a filter sweep on a sustained pad moves the centroid a long way while
 * barely moving the amplitude.
 *
 * Starts at bin 1 to skip DC, which would otherwise pull the centroid toward
 * zero whenever the input has any offset at all.
 */
export function spectralCentroid(spectrum: Uint8Array, binHz: number): number {
  let num = 0;
  let den = 0;
  for (let i = 1; i < spectrum.length; i++) {
    const mag = spectrum[i] / 255;
    num += i * binHz * mag;
    den += mag;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Normalise a centroid in Hz to 0–1 on a log scale.
 *
 * Log, because the centroid is a frequency and the whole point of this file
 * is that frequencies are perceived logarithmically. A linear normalisation
 * would leave the usable range squashed into the bottom tenth.
 */
export function normalizeCentroid(hz: number, fMin = 100, fMax = 8000): number {
  if (hz <= fMin) return 0;
  if (hz >= fMax) return 1;
  return (Math.log2(hz) - Math.log2(fMin)) / (Math.log2(fMax) - Math.log2(fMin));
}
