# Audio analysis

How the numbers a shader receives are produced, and why each choice is what
it is. This is the part of the project with the most non-obvious decisions,
and nearly all of them are cases where the naive implementation produces
something that *looks* like it works.

## The central problem: linear bins, logarithmic hearing

`AnalyserNode.getByteFrequencyData` returns `fftSize / 2` bins spread
**linearly** from 0 Hz to Nyquist. Human pitch perception is
**logarithmic** — an octave is a doubling, wherever you start.

At `fftSize = 2048` and 48 kHz, each bin is 23.4 Hz wide, and the
consequences are severe:

| range        | musical meaning        | bins (of 1024) | share |
| ------------ | ---------------------- | -------------- | ----- |
| 20–250 Hz    | sub-bass and bass      | ~10            | 1%    |
| 250–2000 Hz  | most of the music      | ~75            | 7%    |
| 2000–6000 Hz | presence               | ~170           | 17%   |
| 6000–24000   | air, mostly inaudible  | ~770           | 75%   |

Three quarters of the array describes the range contributing least to how
music sounds, and the bass — which drives most of what people want a
visualiser to react to — gets one percent.

Reading those bins directly is why so many spectrum visualisers are nearly
static at the left and frantic at the right.

### The fix

`buildLogBands()` maps bins into logarithmically spaced bands between 30 Hz
and 16 kHz, so each band covers a roughly constant musical interval. Two
details matter:

- **Skip bin 0.** It is DC offset, not sound. `Math.max(1, ...)` on the
  lower edge.
- **Collapse sub-bin bands.** At the low end a band can be narrower than
  one bin. `Math.max(loBin, hiBin)` makes it read that single bin rather
  than an empty range.

### Mean, not sum

Within a band, take the **mean**. Summing makes treble dominate by
construction: the treble band spans ~770 bins and the bass band ~8, so any
sum is 100× larger for treble before the music has said anything.

The mean has a consequence worth internalising: **a pure sine reads *low* in
a wide band**, because it occupies 3–4 bins out of hundreds. That looks like
a bug the first time you test with a sine wave. It is the behaviour that
makes the whole thing work — see `docs/notes-on-the-spec.md` §3.

## Two analysers, not one

`smoothingTimeConstant` is an exponential moving average across frames. One
value cannot serve both jobs:

|              | fftSize | smoothing | why                                                    |
| ------------ | ------- | --------- | ------------------------------------------------------ |
| **spectral** | 4096    | 0.75      | frequency resolution for bands and centroid; stability |
| **transient**| 512     | **0**     | onset detection; smoothing destroys the signal         |

Running onset detection on the smoothed analyser is the single most common
way to build a detector that reports almost nothing, and it presents as a
threshold problem, so people spend their time tuning the threshold.

The transient analyser's poor frequency resolution (94 Hz per bin) does not
matter: flux does not care *which* bin moved, only that many moved upward at
once.

## Onset detection

Spectral flux: half-wave rectified sum of frame-to-frame bin increases.
Half-wave rectification is what makes it detect *attacks* — a note ending is
a large negative change and is not an onset.

Two departures from the textbook version:

1. **Energy normalisation.** Raw flux spans four orders of magnitude across
   ordinary material, so no absolute floor can serve both a sparse click
   track and dense noise. Dividing by the frame's own energy makes flux a
   *relative* change measure; every steady signal collapses to ~0.05 while a
   real transient still reaches ~1.0. This is the most consequential
   correction in the project — see `notes-on-the-spec.md` §1.

2. **Adaptive median threshold.** `median(history) * sensitivity + delta`. A
   median rather than a mean because a mean is dragged upward by the very
   peaks it is measuring against. Adaptive because a fixed threshold tuned
   on a quiet intro fires continuously through the drop.

**Refractory period: 80 ms.** A single drum hit spreads across two or three
analysis frames; without this it registers as three onsets. 80 ms is below
the fastest musically plausible repeat (a 32nd note at 180 bpm is 83 ms).

### The envelope

`uOnset` is a decaying envelope, not a boolean. A boolean would be true for
one frame — 16 ms, below the threshold at which anyone perceives it — so
every shader author would write their own decay and most would write a
frame-rate dependent one:

```ts
value *= Math.exp(-decayPerSecond * dt); // not value *= 0.9
```

## Spectral centroid

The amplitude-weighted mean frequency. It tracks **timbre**, not volume: it
rises when a sound gets brighter even as it gets quieter. Excellent for
driving colour, poor for driving scale.

Normalised on a log scale between 100 Hz and 8 kHz, because the raw value in
Hz is not something a shader author should have to reason about.

## Beat tracking

Inter-onset-interval histogram, 60–200 bpm. Half and double tempo are
credited at 0.5 weight, because they are genuinely ambiguous and a tracker
that refuses to consider them locks onto the wrong one and stays there.

Reports `bpm: null` until six intervals agree. **Confidence is exposed to
shaders** (`uBeatConfidence`) so a preset can dim itself while unlocked — a
wrong tempo shown confidently is worse than visible uncertainty.

## The latency budget

The important thing about the budget is that **most of it is not overhead**.
Resolving a 40 Hz note requires observing a cycle of it: 25 ms, unavoidable.
A 4096-point window at 48 kHz spans 85 ms, and the result describes the
*centre* of that window, so it is already ~43 ms in the past.

| component       | typical  | controllable?                 |
| --------------- | -------- | ----------------------------- |
| analysis window | 42.7 ms  | only by losing bass resolution |
| graph (base)    | 3–10 ms  | no                            |
| one frame       | 16.7 ms  | somewhat                      |
| output device   | 0–300 ms | no — Bluetooth is the killer  |

**Tolerance is asymmetric.** Visuals lagging by 50 ms read as tight; visuals
*leading* by 50 ms are impossible and would read as wrong. Every uncertainty
is therefore spent on the lag side, which is why `lookaheadSeconds()`
excludes output latency from its compensation even for file sources.

A file source is the one case where the budget can be beaten: the app owns
the playhead, so analysis can run ahead. Live input cannot — there is no
future to read.

## Input constraints

`getUserMedia` defaults destroy music:

```ts
{ echoCancellation: false, noiseSuppression: false, autoGainControl: false }
```

All three default to **on**. AGC is the worst: it flattens exactly the
dynamics being visualised, so a track with a quiet intro and a loud drop
looks the same throughout.

Constraints are *requests*. Several Android devices and some USB interfaces
in communications mode force AGC on regardless, so `inspectConstraints()`
checks `getSettings()` and returns warnings. A user on such a device should
be told why their visuals feel flat rather than concluding the tool is bad.
