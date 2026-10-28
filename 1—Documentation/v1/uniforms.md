# Uniform reference

Everything the prelude declares. All audio values are 0–1 unless noted — a
shader author should never need to know the sample rate to use one.

## Shadertoy-compatible

Named to match Shadertoy so the existing body of shaders pastes in and
works.

| uniform      | type        | meaning                                                          |
| ------------ | ----------- | ---------------------------------------------------------------- |
| `iResolution`| `vec3`      | render size in pixels; `.z` is the aspect ratio                   |
| `iTime`      | `float`     | seconds, on the **audio** clock                                   |
| `iTimeDelta` | `float`     | seconds since last frame, clamped to 1/20                         |
| `iFrame`     | `int`       | frame counter                                                     |
| `iMouse`     | `vec4`      | `xy` position, `zw` click position (negative while button is up)  |
| `iChannel0`  | `sampler2D` | the previous frame, for feedback                                  |

`iTime` runs on `AudioContext.currentTime`, not `performance.now()`. The two
drift by a few milliseconds per minute, which over a three-hour set is
seconds — enough that a beat-locked animation visibly falls behind.

`iTimeDelta` is clamped because a hidden tab throttles `requestAnimationFrame`
to ~1 Hz while audio keeps running. Without the clamp, anything integrating
`dt` lurches by several seconds in one frame when the tab regains focus.

## Audio bands

| uniform     | range        | what lives there                          |
| ----------- | ------------ | ----------------------------------------- |
| `uSub`      | 20–60 Hz     | kick fundamentals, sub-bass               |
| `uBass`     | 60–250 Hz    | bass notes — what most people mean        |
| `uLowMid`   | 250–500 Hz   | body, warmth                              |
| `uMid`      | 500–2000 Hz  | most of the vocal range                   |
| `uHighMid`  | 2000–4000 Hz | presence, attack                          |
| `uTreble`   | 4000–16000   | cymbals, air, sibilance                   |

Each is the **mean** of its log-spaced bins. Note that 60 Hz falls in both
`uSub` and `uBass`; the bands share that boundary deliberately.

## Audio features

| uniform           | meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `uLevel`          | overall loudness (RMS)                                       |
| `uPeak`           | peak sample magnitude; 1.0 means the input is clipping       |
| `uCentroid`       | spectral centroid, log-normalised 100 Hz–8 kHz               |
| `uFlux`           | energy-normalised spectral flux: how fast the spectrum moves |
| `uOnset`          | transient envelope, snaps to 1 and decays                    |
| `uBpm`            | detected tempo, or **0** while unlocked                      |
| `uBeatPhase`      | 0–1 within the current beat                                  |
| `uBeatConfidence` | how much to trust the two above                              |
| `uSpectrum[64]`   | log-banded spectrum, low to high                             |

### Which one to use

The most common mistake is driving everything from `uLevel`, which makes
the whole image throb in unison.

- **Scale, size, displacement** → `uBass` or `uSub`. Low frequencies carry
  the weight and the eye expects large motion to come from them.
- **Colour, hue, brightness** → `uCentroid`. It tracks timbre rather than
  volume, so colour shifts when the *sound* changes rather than when it
  merely gets louder.
- **Flashes, impacts, particle emission** → `uOnset`. It is already an
  envelope; multiplying it by itself (`uOnset * uOnset`) sharpens the attack.
- **Texture, sparkle, high-frequency detail** → `uTreble`. Used as
  brightness it just makes cymbals blow out the image; used as *density* it
  reads correctly.
- **Anything locked to the grid** → `uBeatPhase`, multiplied by
  `uBeatConfidence` so a wrong tempo reads as uncertainty rather than as
  being out of time.

`uBpm` is 0 rather than null while unlocked, because GLSL has no null.
Guard with `uBeatConfidence`, not with `uBpm > 0.0`.

## Helpers

Provided so that every shader does not paste its own copy, and because
several of these are commonly got subtly wrong.

| function                  | notes                                              |
| ------------------------- | -------------------------------------------------- |
| `spectrum(float x)`       | interpolated read of `uSpectrum` at 0–1             |
| `rot(float a)`            | 2×2 rotation matrix                                 |
| `hsv(h, s, v)`            | HSV → RGB                                           |
| `hash(vec2)`              | cheap hash; **not stable across drivers**           |
| `noise(vec2)`             | value noise                                         |
| `fragCoord()`             | pixel coordinates, as Shadertoy's `fragCoord`       |
| `uvCentered()`            | aspect-corrected, centred, y in [-1, 1]             |

Constants `PI` and `TAU` are defined.

## Writing a shader

GLSL ES 3.00. The prelude declares `in vec2 vUv` and `out vec4 fragColor`;
`gl_FragColor` does not exist in 3.00, which is the first thing that breaks
when pasting a shader written for WebGL 1.

Minimal example:

```glsl
void main() {
  vec2 p = uvCentered();
  float r = length(p) * (1.0 + uBass);
  vec3 col = hsv(uCentroid, 0.8, 1.0) * smoothstep(1.0, 0.0, r);
  col += vec3(1.0) * uOnset * uOnset * smoothstep(0.3, 0.0, r);
  fragColor = vec4(col, 1.0);
}
```

Compiler errors are mapped back to your line numbers. If one reports "line
unknown", the driver emitted a format the parser does not recognise — the
raw message is still shown, and it is still a real error.
