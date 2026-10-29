# Audio-Reactive Shader Playground

[![CI](https://github.com/syedjafri06193/Audio-Reactive-Shader-Playground-proj/actions/workflows/ci.yml/badge.svg)](https://github.com/syedjafri06193/Audio-Reactive-Shader-Playground-proj/actions/workflows/ci.yml)

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
├── 1—Documentation/   ← all documentation (index in its README)
│   ├── design.md      ← full design guide
│   ├── design.pdf     ← same guide, PDF
│   └── v1/            audio analysis, uniforms, platform support, spec errata
└── v1/                ← first implementation
    ├── src/           audio, clock, editor, gl, midi, params, presets, shaders, ui
    ├── shaders/       prelude.glsl (shared uniforms and helpers)
    └── tests/         339 tests
```

Each `vN/` directory is a self-contained iteration. Start with
[`v1/README.md`](v1/README.md).

## Versions and feedback

| Version | Summary | Feedback |
|---|---|---|
| [v1](v1/) | Audio analysis layer, hot-reload GLSL editor, MIDI learn, preset morphing, adaptive WebGL renderer | — |

Add a row per version as new iterations land.

## Documentation

All documentation lives in [`1—Documentation/`](1—Documentation/README.md) — start with its index.

<!-- project-metrics:start -->
## Project Metrics

[![Stars](https://img.shields.io/github/stars/syedjafri06193/Audio-Reactive-Shader-Playground-proj?style=flat-square)](https://github.com/syedjafri06193/Audio-Reactive-Shader-Playground-proj/stargazers) [![Forks](https://img.shields.io/github/forks/syedjafri06193/Audio-Reactive-Shader-Playground-proj?style=flat-square)](https://github.com/syedjafri06193/Audio-Reactive-Shader-Playground-proj/forks) [![Open issues](https://img.shields.io/github/issues/syedjafri06193/Audio-Reactive-Shader-Playground-proj?style=flat-square)](https://github.com/syedjafri06193/Audio-Reactive-Shader-Playground-proj/issues) [![Last commit](https://img.shields.io/github/last-commit/syedjafri06193/Audio-Reactive-Shader-Playground-proj/improvements?style=flat-square)](https://github.com/syedjafri06193/Audio-Reactive-Shader-Playground-proj/commits/improvements) [![Commits](https://img.shields.io/github/commit-activity/t/syedjafri06193/Audio-Reactive-Shader-Playground-proj?style=flat-square)](https://github.com/syedjafri06193/Audio-Reactive-Shader-Playground-proj/commits/improvements) [![Top language](https://img.shields.io/github/languages/top/syedjafri06193/Audio-Reactive-Shader-Playground-proj?style=flat-square)](https://github.com/syedjafri06193/Audio-Reactive-Shader-Playground-proj) [![Repo size](https://img.shields.io/github/repo-size/syedjafri06193/Audio-Reactive-Shader-Playground-proj?style=flat-square)](https://github.com/syedjafri06193/Audio-Reactive-Shader-Playground-proj)

### Code

| Metric | Value |
|---|---|
| Lines of code | 5,313 |
| Source files | 44 |
| Tracked files | 60 |
| Documentation | 8 Markdown files (15,050 words), 1 PDF |
| Commits | 9 |
| Contributors | 1 |
| Active | 2026-09-11 → 2026-10-28 |

| Language | Lines | Share |
|---|---:|---:|
| TypeScript | 5,111 | 96.2% |
| CSS+Lasso | 148 | 2.8% |
| HTML | 54 | 1.0% |

### Performance

| Metric | Result |
|---|---|
| Onset signal, click track (normalised peak) | **0.996** |
| Onset signal, steady white noise (normalised peak) | 0.078 |
| Window / frame rate | 512-point window at 60 fps |

<sub>Measured figures recorded in [`1—Documentation/v1/notes-on-the-spec.md`](1%E2%80%94Documentation/v1/notes-on-the-spec.md).</sub>

<sub>Code stats as of 2026-10-28, counted with pygount (comments and blank lines excluded). Badges update live.</sub>
<!-- project-metrics:end -->
