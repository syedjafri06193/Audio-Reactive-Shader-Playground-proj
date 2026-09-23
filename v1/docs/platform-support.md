# Platform support

What works where, and what to do about the gaps. The general principle: a
missing capability is designed for, not apologised for. Every feature that
can be absent has a path where the application is still useful without it.

## Summary

| capability                      | Chrome/Edge | Firefox | Safari  |
| ------------------------------- | ----------- | ------- | ------- |
| WebGL2                          | ✅          | ✅      | ✅ 15+  |
| Web Audio / AnalyserNode        | ✅          | ✅      | ✅      |
| `getUserMedia` (microphone)     | ✅          | ✅      | ✅      |
| `getDisplayMedia` **with audio** | ✅ (tab)   | ⚠️      | ❌      |
| **Web MIDI**                    | ✅          | ❌      | ❌      |
| `KHR_parallel_shader_compile`   | ✅ 76+      | ❌      | ✅ 14.1+|
| `EXT_color_buffer_float`        | ✅          | ✅      | ⚠️      |
| `AudioContext.outputLatency`    | ✅          | ⚠️ 0    | ❌      |
| `WEBGL_debug_renderer_info`     | ⚠️          | ⚠️      | ❌      |

## Web MIDI: absent in Safari and Firefox

Not disabled, not behind a flag — **absent**. Firefox has declined to
implement it on fingerprinting grounds; Safari has never shipped it.

This is a large fraction of users, so MIDI is an **enhancement, never a
requirement**. Every parameter is reachable from the UI panel, and the MIDI
section explains what is missing rather than showing a dead button.

`checkMidiAvailability()` distinguishes the causes, because the remedies
differ:

- **Not implemented** — nothing the user can do. Say so plainly and note
  that everything still works.
- **Insecure context** — Web MIDI needs HTTPS or localhost. Actionable.
- **Permission denied** — recoverable via the address bar's site settings.

Sysex is deliberately **not** requested. It triggers a more alarming
permission prompt and is needed only for controller-specific feature sets
this does not use.

## Parallel shader compile: two real code paths

`KHR_parallel_shader_compile` lets the driver link off the main thread.
Firefox has never shipped it, and **there is nothing to polyfill** — the
blocking behaviour is the driver's.

So there are genuinely two paths:

- **With the extension**: poll `COMPLETION_STATUS_KHR` once per frame from
  the render loop. Never call `getProgramParameter(LINK_STATUS)` before it
  reports done — that is a synchronous flush which discards the entire
  benefit.
- **Without it**: `linkProgram` has already blocked by the time it returns,
  so resolve immediately. Polling would only add a frame of latency.

Either way the live program is never unbound until the replacement links,
so a compile stall never blanks the picture.

## Compiler error formats

Three families, and a regex tuned on one silently produces wrong line
numbers on another — which is worse than no line number, because the user
goes and reads the wrong code.

```
ANGLE (Chrome/Edge):   ERROR: 0:47: 'foo' : undeclared identifier
Mesa (Linux):          0:47(12): error: `foo' undeclared
Apple:                 ERROR: 47: 'foo' : undeclared identifier
```

Note the classic trap: in `ERROR: 0:47:` the `0` is the *shader string
index*, not the line. Reading the first number gives every error the same
line number.

Unrecognised formats are kept with `line: null` rather than dropped. A
driver nobody anticipated still reports real errors, and silence is the
worst possible response to one.

## Context loss

Routine, not exotic: a laptop switching GPUs, a driver update, the OS
reclaiming memory, a tab backgrounded long enough. On a page left running
on a projector all evening it will happen.

**`e.preventDefault()` on `webglcontextlost` is mandatory.** Without it the
browser never fires `webglcontextrestored` and the canvas is dead until
reload. That one line is the entire recovery path.

Because every GL object is invalid after a loss — including uniform
locations — resources are registered with a factory rather than created
inline, so restore is a loop rather than an audit of every allocation site.

A "simulate context loss" control is exposed via `WEBGL_lose_context`.
Almost nobody tests this path because it is untriggerable by hand, which is
why almost every WebGL page is broken in exactly this way.

## Float render targets

Feedback buffers use `RGBA16F`. At 8 bits per channel each pass quantises,
and after ~30 frames of a decaying trail the gradient visibly bands.

`EXT_color_buffer_float` is required and is occasionally missing on older
mobile GPUs. `RenderTarget` names the format in its error rather than
reporting a bare hex status code, so the failure is actionable.

Full float is not used: twice the bandwidth again, and on many mobile GPUs
not filterable anyway.

## Output latency reporting

Chrome reports `AudioContext.outputLatency` honestly. Firefox reports `0`.
Safari does not implement it.

A zero therefore means **unknown**, not **none**, and is reported that way —
treating it as zero would understate the budget on exactly the platforms
where it matters. Bluetooth output adds 150–300 ms and nothing in the page
can change that; naming it explicitly is the difference between "this tool
is broken" and "these are my headphones".

## Tab audio capture

`getDisplayMedia({ audio: true })` is Chrome-and-Edge in practice, and only
for tab capture (not whole-screen on most platforms). Safari does not
support audio capture at all here; Firefox's support is partial.

The file and microphone paths work everywhere, and the file path is the
better one regardless — it is the only source whose analysis can run ahead
of playback.

## Mobile

Works, with caveats worth stating:

- An AudioContext must be created inside a user gesture or it starts
  suspended, and a suspended context produces an analyser full of zeros —
  which looks exactly like a broken analyser.
- `devicePixelRatio` is capped at 2. A 3× render at full resolution is a
  9× pixel cost for a difference nobody can see on a phone.
- The resolution scaler earns its keep here more than anywhere else.
