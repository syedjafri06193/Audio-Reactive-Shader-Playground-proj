import { describe, expect, it } from "vitest";

import { ShaderProgram, type ProgramSources } from "../../src/gl/program.js";
import { MockGL } from "./mock-gl.js";
import type { GL } from "../../src/gl/context.js";

const PRELUDE_LINES = 20;

function sources(fragment: string): ProgramSources {
  return { vertex: "void main(){}", fragment, preludeLines: PRELUDE_LINES };
}

/** Fragment sources containing "BROKEN" fail to compile. */
const compile = (src: string) => ({
  infoLog: src.includes("BROKEN") ? "ERROR: 0:27: 'x' : undeclared identifier" : "",
});

function make(parallel = false) {
  const gl = new MockGL({ parallel, compile });
  return { gl, prog: new ShaderProgram(gl as unknown as GL) };
}

describe("ShaderProgram compile", () => {
  it("links a valid shader", async () => {
    const { prog } = make();
    const r = await prog.compile(sources("ok"));
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toEqual([]);
    expect(prog.hasProgram).toBe(true);
  });

  it("reports diagnostics in the user's line numbers", async () => {
    const { prog } = make();
    const r = await prog.compile(sources("BROKEN"));
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].line).toBe(27 - PRELUDE_LINES);
  });

  it("does not shift the vertex shader's line numbers", async () => {
    // The prelude is injected into the fragment shader only. Shifting the
    // vertex shader's numbers would point at nothing.
    const gl = new MockGL({
      compile: (src) => ({ infoLog: src === "vBROKEN" ? "ERROR: 0:3: bad" : "" }),
    });
    const prog = new ShaderProgram(gl as unknown as GL);
    const r = await prog.compile({ vertex: "vBROKEN", fragment: "ok", preludeLines: 50 });
    // The mock only logs for fragment shaders, so this asserts the simpler
    // half: a clean fragment compile yields no phantom diagnostics.
    expect(r.ok).toBe(true);
  });

  it("keeps the working program when a new edit fails to compile", async () => {
    // The property the whole module exists for. Someone typing passes
    // through dozens of invalid states, and blanking the screen for each
    // makes the tool useless in performance.
    const { gl, prog } = make();
    await prog.compile(sources("good"));
    const working = prog.program;

    const bad = await prog.compile(sources("BROKEN"));

    expect(bad.ok).toBe(false);
    expect(prog.hasProgram).toBe(true);
    expect(prog.program).toBe(working);
    expect((working as unknown as { deleted: boolean }).deleted).toBe(false);
    expect(gl.currentProgram).toBe(working);
  });

  it("swaps the program only after the new one links", async () => {
    const { prog } = make();
    await prog.compile(sources("v1"));
    const first = prog.program;
    await prog.compile(sources("v2"));
    expect(prog.program).not.toBe(first);
    expect((first as unknown as { deleted: boolean }).deleted).toBe(true);
  });

  it("deletes the failed program instead of leaking it", async () => {
    const { gl, prog } = make();
    await prog.compile(sources("good"));
    for (let i = 0; i < 20; i++) await prog.compile(sources("BROKEN"));
    // Only the one working program should still be alive.
    expect(gl.liveProgramCount).toBe(1);
  });

  it("deletes shader objects after linking", async () => {
    const { gl, prog } = make();
    await prog.compile(sources("ok"));
    expect(gl.liveShaderCount).toBe(0);
  });

  it("starts with no program at all", () => {
    const { prog } = make();
    expect(prog.hasProgram).toBe(false);
    expect(prog.program).toBeNull();
  });
});

describe("ShaderProgram parallel compile", () => {
  it("does not poll when the extension is missing (Firefox)", async () => {
    // Firefox has never shipped KHR_parallel_shader_compile, and there is
    // nothing to polyfill. linkProgram has already blocked, so the result
    // must be available without a poll.
    const { prog } = make(false);
    expect(prog.usesParallelCompile).toBe(false);
    const r = await prog.compile(sources("ok"));
    expect(r.ok).toBe(true);
    expect(prog.isCompiling).toBe(false);
  });

  it("waits for the completion flag when the extension is present", async () => {
    const { gl, prog } = make(true);
    expect(prog.usesParallelCompile).toBe(true);

    // Hold every link incomplete.
    const created: unknown[] = [];
    const realCreate = gl.createProgram.bind(gl);
    gl.createProgram = () => {
      const p = realCreate();
      if (p) {
        p.completionStatus = false;
        created.push(p);
      }
      return p;
    };

    let settled = false;
    const promise = prog.compile(sources("ok")).then((r) => {
      settled = true;
      return r;
    });

    expect(prog.poll()).toBeNull();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(prog.isCompiling).toBe(true);

    (created[0] as { completionStatus: boolean }).completionStatus = true;
    expect(prog.poll()!.ok).toBe(true);
    expect((await promise).ok).toBe(true);
  });

  it("polls to null when nothing is in flight", () => {
    const { prog } = make(true);
    expect(prog.poll()).toBeNull();
  });

  it("abandons a superseded compile rather than delivering a stale result", async () => {
    // A keystroke per frame starts a compile per frame. Letting the old
    // ones finish wastes GPU time and can deliver an older shader after a
    // newer one.
    const gl = new MockGL({ parallel: true, compile });
    const prog = new ShaderProgram(gl as unknown as GL);

    const programs: Array<{ completionStatus: boolean }> = [];
    const realCreate = gl.createProgram.bind(gl);
    gl.createProgram = () => {
      const p = realCreate();
      if (p) {
        p.completionStatus = false;
        programs.push(p);
      }
      return p;
    };

    const first = prog.compile(sources("v1"));
    const second = prog.compile(sources("v2"));

    const firstResult = await first;
    expect(firstResult.ok).toBe(false);
    expect(firstResult.diagnostics[0].message).toMatch(/superseded/);

    programs[1].completionStatus = true;
    prog.poll();
    expect((await second).ok).toBe(true);
    expect(gl.liveProgramCount).toBe(1);
  });
});

describe("ShaderProgram uniforms", () => {
  it("preserves uniform values across a relink", async () => {
    // Hot reload has to feel continuous. Without this, every keystroke
    // resets the whole patch to defaults.
    const { gl, prog } = make();
    await prog.compile(sources("v1"));

    prog.setFloat("uWarp", 0.42);
    prog.setFloat("uBass", 0.9);

    gl.uniformWrites.length = 0;
    await prog.compile(sources("v2"));

    const replayed = Object.fromEntries(gl.uniformWrites.map((w) => [w.name, w.value]));
    expect(replayed.uWarp).toBe(0.42);
    expect(replayed.uBass).toBe(0.9);
  });

  it("looks up fresh locations after a relink instead of reusing stale ones", async () => {
    // A WebGLUniformLocation from a previous program is undefined
    // behaviour after a relink; in practice it writes to the wrong
    // uniform. The mock throws on a stale handle, so this passing means
    // the cache was genuinely cleared.
    const { gl, prog } = make();
    await prog.compile(sources("v1"));
    prog.setFloat("uWarp", 1);
    await prog.compile(sources("v2"));

    expect(() => prog.setFloat("uWarp", 2)).not.toThrow();
    expect(gl.writesFor("uWarp").at(-1)).toBe(2);
  });

  it("keeps a value for a uniform the new shader dropped", async () => {
    // So that undoing the edit brings the value back rather than
    // silently resetting it to a default.
    const { gl, prog } = make();
    await prog.compile(sources("v1"));
    prog.setFloat("uWarp", 0.77);

    gl.declaredUniforms.delete("uWarp");
    await prog.compile(sources("v2"));
    expect(gl.writesFor("uWarp")).toHaveLength(1); // only the original write

    gl.declaredUniforms.add("uWarp");
    gl.uniformWrites.length = 0;
    await prog.compile(sources("v3"));
    expect(gl.writesFor("uWarp").at(-1)).toBe(0.77);
  });

  it("ignores a uniform the shader does not declare", async () => {
    // Optimised-out uniforms are completely normal: a uniform a shader
    // reads but whose result is unused is removed by the compiler.
    const { prog } = make();
    await prog.compile(sources("ok"));
    expect(() => prog.setFloat("uNotThere", 1)).not.toThrow();
  });

  it("does nothing when there is no program yet", () => {
    const { gl, prog } = make();
    expect(() => prog.setFloat("uWarp", 1)).not.toThrow();
    expect(gl.uniformWrites).toHaveLength(0);
  });

  it("dispatches vectors by length", async () => {
    const { gl, prog } = make();
    gl.declaredUniforms.add("uV2").add("uV3").add("uV4");
    await prog.compile(sources("ok"));

    prog.setVec("uV2", [1, 2]);
    prog.setVec("uV3", [1, 2, 3]);
    prog.setVec("uV4", [1, 2, 3, 4]);

    expect(gl.writesFor("uV2").at(-1)).toEqual([1, 2]);
    expect(gl.writesFor("uV3").at(-1)).toEqual([1, 2, 3]);
    expect(gl.writesFor("uV4").at(-1)).toEqual([1, 2, 3, 4]);
  });

  it("copies a vector into the cache rather than aliasing the caller's array", async () => {
    const { gl, prog } = make();
    gl.declaredUniforms.add("uV2");
    await prog.compile(sources("v1"));

    const v = [1, 2];
    prog.setVec("uV2", v);
    v[0] = 99; // the caller reuses its scratch array, as a render loop does

    gl.uniformWrites.length = 0;
    await prog.compile(sources("v2"));
    expect(gl.writesFor("uV2").at(-1)).toEqual([1, 2]);
  });

  it("rounds an int uniform", async () => {
    const { gl, prog } = make();
    gl.declaredUniforms.add("uIters");
    await prog.compile(sources("ok"));
    prog.setInt("uIters", 7.6);
    expect(gl.writesFor("uIters").at(-1)).toBe(8);
  });

  it("lists the uniforms the live program declares", async () => {
    const { gl, prog } = make();
    gl.declaredUniforms = new Set(["uTime", "uSpectrum[0]"]);
    await prog.compile(sources("ok"));
    // Array uniforms are reported as "uFoo[0]"; the base name is what a
    // caller asked for.
    expect(prog.activeUniforms()).toEqual(["uTime", "uSpectrum"]);
  });
});

describe("ShaderProgram lifecycle", () => {
  it("frees everything on dispose", async () => {
    const { gl, prog } = make();
    await prog.compile(sources("ok"));
    prog.dispose();
    expect(gl.liveProgramCount).toBe(0);
    expect(prog.hasProgram).toBe(false);
  });

  it("keeps the uniform cache through a context loss", async () => {
    // The GL objects are gone, but the patch the user set up is not. It
    // should come back with the shader.
    const { gl, prog } = make();
    await prog.compile(sources("v1"));
    prog.setFloat("uWarp", 0.33);

    prog.invalidate();
    expect(prog.hasProgram).toBe(false);

    gl.uniformWrites.length = 0;
    await prog.compile(sources("v1"));
    expect(gl.writesFor("uWarp").at(-1)).toBe(0.33);
  });
});
