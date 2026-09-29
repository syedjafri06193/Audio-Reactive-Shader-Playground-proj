# Audio-Reactive Shader Playground

A browser live-coding environment for GLSL shaders driven by audio analysis:
write a fragment shader, point it at a microphone or a file, and the music
drives its uniforms. Includes preset morphing, MIDI controller bindings, and
hot-reloading GLSL editing.

```
 mic / file ──► Web Audio AnalyserNode ──► log bands · onset detection · beat tracking
                                                   │
 MIDI (learn, takeover, slew) ──► parameters ◄─────┘ ◄── preset morphing
                                       │
 GLSL editor (hot reload, never blanks) ──► WebGL renderer (adaptive resolution, context-loss recovery)
```

## Highlights

- **Log-banded spectrum** that matches how hearing works, not linear FFT bins.
- **Onset detection** via normalised spectral flux with an adaptive threshold.
- **Beat tracking** with an honest confidence value.
- **Hot reload that never blanks the screen** — a broken edit keeps the last working shader running.
- **MIDI learn** with three takeover modes, degrading gracefully where Web MIDI is missing.
- **Adaptive resolution** and working **WebGL context-loss recovery**.

## Quick start

Needs Node.js 22:

```bash
cd v1
npm install
npm run dev        # http://localhost:5173
npm test           # 339 tests
npm run build
```

CI runs typecheck, tests and build on every push
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Repository layout

```
.
├── README.md          ← you are here
├── .github/workflows/ ← CI: typecheck, test, build
├── docs/
│   ├── design.md      ← full design guide
│   └── design.pdf     ← same guide, PDF
└── v1/                ← first implementation
    ├── src/           audio, clock, editor, gl, midi, params, presets, shaders, ui
    ├── shaders/       prelude.glsl (shared uniforms and helpers)
    ├── tests/         339 tests
    └── docs/          audio analysis, uniforms, platform support, spec errata
```

Each `vN/` directory is a self-contained iteration. Start with
[`v1/README.md`](v1/README.md).

## Versions and feedback

| Version | Summary | Feedback |
|---|---|---|
| [v1](v1/) | Audio analysis layer, hot-reload GLSL editor, MIDI learn, preset morphing, adaptive WebGL renderer | — |

Add a row per version as new iterations land.
