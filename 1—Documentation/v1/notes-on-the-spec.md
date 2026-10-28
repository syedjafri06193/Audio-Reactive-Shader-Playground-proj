# Notes on the spec

Places where building this turned up something the design document got
wrong, left ambiguous, or where measurement disagreed with the reference
material. Each entry says what the document says, what actually happens,
and what this implementation does instead.

The document is good and most of it survived contact with a compiler intact.
These are the exceptions.

---

## 1. Raw spectral flux is not scale-invariant, and no fixed floor can work

**§4.5** gives spectral flux as the sum of positive frame-to-frame bin
changes, compared against `median(history) * sensitivity`, with a small
absolute floor to stop the threshold collapsing to zero on silence.

That floor cannot be chosen. Raw flux spans four orders of magnitude across
ordinary material, so any floor permissive enough to pass a click track
fires on every frame of dense noise. Measured over a 512-point window at
60 fps:

| signal             | raw p50 | raw peak | normalised p50 | normalised peak |
| ------------------ | ------- | -------- | -------------- | --------------- |
| steady white noise | 10.9    | 15.8     | 0.054          | 0.078           |
| sustained pad      | 0.51    | 2.97     | 0.050          | 0.293           |
| 440 Hz sine        | 0.067   | 0.42     | 0.0067         | 0.041           |
| click track        | 0.0     | 113.8    | 0.0            | 0.996           |

Implementing it as written produced 21 false detections on a steady 440 Hz
sine and missed an attack on top of a sustained pad — the exact case §4.5
says flux exists to catch.

**What this does instead.** Divide the rectified sum by the frame's own
energy, turning flux from an absolute change measure into a relative one:

```ts
const flux = rectified / (energy + ENERGY_EPSILON);
const threshold = this.median() * this.sensitivity + this.delta;
```

Every steady signal then collapses to about 0.05 regardless of how loud it
is, while a real transient still reaches ~1.0 — a usable margin that holds
across all four signals above. The separate floor disappears; `delta`
becomes an additive term on the adaptive threshold, which is what keeps it
meaningful when the median is near zero on sparse material.

Covered by `tests/audio/onset.test.ts`.

---

## 2. The document's own bass-band test is ambiguous

**§15.1** suggests testing that "the bass band responds to a 60 Hz sine".

60 Hz is exactly the boundary between `sub` (20–60 Hz) and `bass`
(60–250 Hz) in the band table the document gives in **§14.1**, so it lands
in both. Under the per-band *mean* — which the same section correctly
insists on — the narrower `sub` band wins, because the sine's energy fills
proportionally more of it. The suggested test fails against a correct
implementation.

**What this does instead.** Tests band dominance at 100 Hz, unambiguously
inside `bass`, and adds a test that documents the boundary behaviour
explicitly rather than leaving it to be rediscovered.

---

## 3. A pure sine reads *low* in a wide band — which is the point

Not an error in the document, but a trap it does not warn about, and one
that cost real debugging time here.

Taking the mean rather than the sum (**§14.1**, correctly) means a pure tone
occupying 3–4 bins reads as a *small* value in a band spanning 500 bins.
That looks like a bug when a test feeds a 440 Hz sine into `mid` and gets
0.02. It is not: it is precisely the behaviour that stops treble
dominating, since treble spans ~770 bins and bass ~8.

**What this does instead.** The band tests use a broadband fixture
(`bandNoise()`, log-spaced partials with decorrelated phases) that
resembles real music, assert on *which band is loudest* rather than on
absolute magnitudes, and include one test that documents the sine-reads-low
property so the next person does not treat it as a regression.

---

## 4. `lerpAngle(350, 10, 0.5)` returns 360, not 0

**§15.2** gives this test:

```ts
expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0); // not 180
```

The "not 180" is the real content and it is right. But 0 and 360 are the
same angle, and returning the unwrapped 360 is the better behaviour: a
wrapped result puts a discontinuity in the middle of a transition, and
anything downstream that smooths the value — `midi/slew.ts` does exactly
that — sees a 360° jump and spins the shader most of a turn backwards to
catch up.

**What this does instead.** `lerpAngle` returns a continuous value and
`wrapDegrees()` is provided for display. The test asserts on the circle.

---

## 5. OKLab's midpoint is not perceptual mid-grey, so "even perceptual steps" is the wrong claim

**§7.3** motivates OKLab for colour interpolation. The motivation is
correct, but the natural way to test it — "the black-to-white ramp moves in
even perceptual steps" — is false, and an early version of these tests
asserted it.

OKLab's `L` is the cube root of luminance for greys, not CIE `L*`. The
midpoint of black→white is `#636363` (luminance 0.125), while perceptual
mid-grey (`L* = 50`) is nearer `#777777` (luminance 0.18). OKLab is not
evenly spaced in `L*` and does not claim to be.

**What this does instead.** Tests the property that is actually true and is
what §7.3 is really about — **a blend never goes darker than the darker of
its two endpoints**. Measured max dip below that floor:

| pair        | sRGB   | OKLab  |
| ----------- | ------ | ------ |
| red→green   | 0.0650 | 0.0000 |
| red→blue    | 0.0243 | 0.0000 |
| blue→yellow | 0.0060 | 0.0000 |
| blue→white  | 0.0000 | 0.0000 |

Plus the sharpest single illustration: the sRGB midpoint of blue and yellow
is `#808080`, literally neutral grey, with no trace of either colour.

---

## 6. MIDI learn cannot use summed travel

**§8.2** says to bind "the control that moved most", which is the right
idea and fixes the real problem (controllers emit unsolicited traffic).
Implemented as summed absolute movement, it fails: a control dithering by
one step accumulates travel without bound just by sitting there, so a noisy
pad left alone for a second out-scores a knob the user actually swept. A
ten-message ±1 dither scored 9 against a threshold of 8.

**What this does instead.** Ranks by **range** (`max - min`), which is
immune to dither — a jittering control has a range of 1 however long it
runs — while still catching the case summed travel was meant to handle, a
knob swept up and brought back, whose range is the full extent of the
sweep.

---

## 7. Learn also needs a settle window, or the tie-break never fires

Related but separate, and not mentioned in §8.2 at all.

MIDI messages interleave. When two controls move together, whichever one
happens to report first crosses the threshold one message before its rival,
so a "bind when the winner is clearly ahead" check compares the winner
against a runner-up that has not been seen yet. The result is a coin flip
that resolves differently between attempts — the exact failure the
tie-break exists to prevent.

**What this does instead.** Once anything crosses the threshold, keep
listening for 150 ms before deciding, so every moving control has reported
and the comparison is made on equal evidence.

---

## 8. Morph completion needs an epsilon

Not in the document, and it bites.

Accumulating `dt` in floating point leaves elapsed time a hair under the
duration — sixty additions of `1/60` sum to `0.9999999999999999` — so a
strict `elapsed >= duration` never fires. For a parameter morph that is
cosmetic. For a **crossfade** it is not: the transition never reports done,
both shaders keep rendering, and the resolution stays pinned at 0.7×
indefinitely.

**What this does instead.** Completion is `elapsed >= duration - 1e-6`, and
the final frame snaps `t` to exactly 1.

---

## 9. `register()` should fail loudly at startup and quietly on restore

**§6.5** describes declarative resource registration for context-loss
recovery but does not say what to do when a resource fails to *rebuild*.

The two cases want opposite behaviour. Failing to allocate at startup means
the application cannot run and the user should be told immediately. Failing
during a restore is recoverable: a playground that comes back with three of
four passes working is far better than one that comes back blank, and a GPU
that has just reset may genuinely have less memory than it did.

**What this does instead.** `register()` propagates a first-build failure;
restore catches per resource, logs what failed, and rebuilds the rest.

---

## 10. The default latency configuration sits exactly on the boundary

**§3** gives 60–150 ms as the realistic range and treats under 60 ms as
tight. The document's own recommended configuration — 4096-point spectral
window at 48 kHz — comes to 42.7 ms of analysis plus one 16.7 ms frame:
**59.4 ms**, inside "tight" by 0.6 ms and with no margin at all.

Any of a 30 Hz display, a reported output latency, or a slightly larger
window moves it into "acceptable". This is not a problem — the 4096 window
is the right trade, because 1024 cannot separate musical notes between 40
and 80 Hz — but the document presents the budget as comfortable when it is
in fact exactly at the line.

Recorded as an explicit test so the number cannot drift unnoticed.

---

## Smaller corrections

- **§4.1** lists the three `getUserMedia` flags to disable. Worth adding:
  `getSettings()` can report them still enabled — several Android devices
  and some USB interfaces in communications mode force AGC on regardless.
  The constraints are requests, so the only honest thing is to verify and
  tell the user why their visuals look flat.

- **§6.3** says `KHR_parallel_shader_compile` is absent in Firefox. Worth
  being explicit that this means two genuine code paths rather than a
  polyfill: there is nothing to polyfill, and on the blocking path polling
  only adds latency because `linkProgram` has already returned.

- **§10** does not say that `uSpectrum`'s array size must be a compile-time
  constant in GLSL ES 3.00. The band count is therefore substituted into
  the prelude at build time, and the prelude's line count must be *derived*
  from the file rather than written down — a hard-coded offset breaks every
  error message in the application the first time someone adds a uniform.

- **§9.2** specifies asymmetric scaling rates but not a settle period.
  Without one, the framebuffer reallocation caused by a scale change is
  itself measured as a slow frame and triggers another drop, walking the
  resolution to the floor in a few windows.
