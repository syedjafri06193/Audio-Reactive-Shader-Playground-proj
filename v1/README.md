# Audio-Reactive Shader Playground

A live-coding environment for GLSL shaders driven by audio analysis. Write
a fragment shader in the browser, point it at a microphone or a file, and
the music drives its uniforms.

The interesting part of this project is not the shader editor. It is the
analysis layer: getting from `AnalyserNode` to numbers that actually
correspond to what a person hears, which turns out to require undoing most
of what the Web Audio API hands you.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 339 tests
npm run typecheck
npm run build
```

## What it does

- **Log-banded spectrum analysis** that matches how hearing works, rather
  than the linear FFT bins the API returns.
- **Onset detection** via energy-normalised spectral flux with an adaptive
  threshold, so it works on both a sparse click track and a dense mix.
- **Beat tracking** with an honest confidence value, so a preset can show
  uncertainty instead of confidently being out of time.
- **Hot reload that never blanks the screen** — a broken edit leaves the
  working shader running.
- **MIDI control** with learn, three takeover modes, and graceful absence
  on the browsers that do not have Web MIDI.
- **Adaptive resolution** driven by p90 frame time with asymmetric rates.
- **Context-loss recovery** that actually works, with a button to test it.

## The five things that matter

Most of the difficulty in this project is in places where the obvious
implementation produces something that looks like it works.

### 1. Linear bins vs logarithmic hearing

`getByteFrequencyData` spreads bins linearly to Nyquist. At `fftSize 2048`
and 48 kHz, 20–250 Hz gets about **1%** of the array and 6–24 kHz gets
about **75%** — the exact inverse of how music is distributed. Reading
those bins directly is why so many visualisers are dead at the left and
frantic at the right.

Bands are log-spaced, and within a band the value is the **mean**, not the
sum. Summing makes treble dominate by construction: treble spans ~770 bins
and bass ~8.

### 2. One smoothing constant cannot serve two jobs

`smoothingTimeConstant` high enough to stop colours flickering is high
enough to miss every kick. So there are two analysers: a 4096-point one at
0.75 smoothing for bands and centroid, and a 512-point one at **0**
smoothing for onsets.

Running onset detection on the smoothed analyser is the most common way to
build a detector that reports almost nothing — and it presents as a
threshold problem, so people tune the threshold for hours.

### 3. Spectral flux must be energy-normalised

The textbook version compares raw flux against an adaptive median plus a
small absolute floor. That floor cannot be chosen: raw flux spans four
orders of magnitude across ordinary material, so any floor permissive
enough to pass a click track fires on every frame of dense noise.

Measured here, the textbook version produced 21 false detections on a
steady sine and missed an attack on a pad. Dividing by the frame's own
energy fixes it: every steady signal collapses to ~0.05 while a transient
still reaches ~1.0. See [`docs/notes-on-the-spec.md`](docs/notes-on-the-spec.md).

### 4. The latency budget is mostly physics

Resolving a 40 Hz note requires observing a cycle of it. A 4096-point
window spans 85 ms and its result describes the window's *centre*, so it is
already ~43 ms in the past before anything else happens.

Tolerance is **asymmetric**: lagging by 50 ms reads as tight, leading by
50 ms is impossible. Every uncertainty is spent on the lag side.

### 5. A broken edit must never take the picture away

Someone typing during a performance passes through dozens of invalid states
on the way to a working one. The obvious implementation — delete, compile,
bind — blanks the screen for each of them, and for the whole duration of
the compile.

The live program is never unbound until a replacement has linked. Uniform
values survive the relink, so the patch is not reset on every keystroke.

## Layout

```
src/
  audio/      bands, onset, beat, features, source, latency
  gl/         context, program, fbo, scaler, errors, renderer
  params/     interpolate, schema, modulation
  midi/       access, learn, slew, takeover
  clock/      the render loop and its two clocks
  presets/    morph + the built-in library
  editor/     CodeMirror with a diagnostics gutter
  shaders/    prelude assembly and line mapping
shaders/
  prelude.glsl
docs/
  audio-analysis.md     how the numbers are produced
  uniforms.md           what a shader receives
  platform-support.md   what works where
  notes-on-the-spec.md  where the design doc was wrong
```

## Tests

339 tests, all of which run without a browser.

The audio tests do not mock the FFT — `tests/audio/fixtures.ts` contains a
real radix-2 Cooley–Tukey implementation and a `byteSpectrum()` that
reproduces `getByteFrequencyData`'s exact pipeline (Hann window → FFT →
magnitude → dB → scale to 0–255). Band and onset behaviour is asserted
against synthesized sines, chords, band-limited noise and click tracks.

The GL tests use a mock context that models object *lifetimes*, so a stale
uniform location after a relink — the bug the last-good-program design
exists to prevent — is a test failure rather than something you find on
someone else's driver.

Several tests exist specifically to document a surprise:

- a sine reads *low* in a wide band, and that is correct;
- 60 Hz falls in two bands at once;
- OKLab's midpoint is `#636363`, not perceptual mid-grey;
- the default latency configuration sits 0.6 ms inside "tight".

## Notes on the design document

Ten places where building this disagreed with the spec are recorded in
[`docs/notes-on-the-spec.md`](docs/notes-on-the-spec.md), with measurements.
The largest are the flux normalisation (§1), the MIDI-learn scoring metric
(§6–7), and a crossfade that would have stayed at 0.7× resolution forever
because sixty additions of `1/60` do not sum to `1` (§8).
