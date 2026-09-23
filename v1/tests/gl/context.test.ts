import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ATTRIBUTES, GLContext, type ContextOptions } from "../../src/gl/context.js";
import { MockCanvas, MockGL } from "./mock-gl.js";

function make(options: ContextOptions = {}) {
  const canvas = new MockCanvas(new MockGL());
  const ctx = new GLContext(canvas as unknown as HTMLCanvasElement, options);
  return { canvas, ctx };
}

describe("GLContext", () => {
  it("throws a useful message when WebGL2 is unavailable", () => {
    const canvas = new MockCanvas();
    canvas.contextResult = null;
    expect(() => new GLContext(canvas as unknown as HTMLCanvasElement)).toThrow(/WebGL2/);
  });

  it("asks for attributes suited to a full-screen shader", () => {
    // Each of these is a real per-frame cost on a full-screen canvas, and
    // the defaults are the expensive ones.
    expect(DEFAULT_ATTRIBUTES.alpha).toBe(false);
    expect(DEFAULT_ATTRIBUTES.antialias).toBe(false);
    expect(DEFAULT_ATTRIBUTES.preserveDrawingBuffer).toBe(false);
    expect(DEFAULT_ATTRIBUTES.powerPreference).toBe("high-performance");
  });

  it("builds a registered resource immediately", () => {
    const { ctx } = make();
    const handle = ctx.register({ label: "tex", create: () => ({ id: 1 }) });
    expect(handle.alive).toBe(true);
    expect(handle.value).toEqual({ id: 1 });
  });
});

describe("GLContext loss and restore", () => {
  it("calls preventDefault on webglcontextlost", () => {
    // Without this the browser never fires webglcontextrestored and the
    // canvas is dead until a reload. It is the entire recovery path.
    const { canvas } = make();
    expect(canvas.fire("webglcontextlost").defaultPrevented).toBe(true);
  });

  it("marks every resource dead on loss", () => {
    const { canvas, ctx } = make();
    const a = ctx.register({ label: "a", create: () => ({}) });
    const b = ctx.register({ label: "b", create: () => ({}) });

    canvas.fire("webglcontextlost");

    expect(a.alive).toBe(false);
    expect(b.alive).toBe(false);
    expect(ctx.isLost).toBe(true);
  });

  it("throws rather than returning null when a dead resource is read", () => {
    // A caller that silently skips a missing resource draws a black frame
    // and reports nothing. Throwing lets the render loop say why.
    const { canvas, ctx } = make();
    const h = ctx.register({ label: "spectrumTexture", create: () => ({}) });
    canvas.fire("webglcontextlost");
    expect(() => h.value).toThrow(/spectrumTexture/);
  });

  it("does not dispose resources during a loss", () => {
    // Every GL object is already invalid; calling deleteTexture on one is
    // at best a no-op and at worst a driver crash.
    const dispose = vi.fn();
    const { canvas, ctx } = make();
    ctx.register({ label: "a", create: () => ({}), dispose });

    canvas.fire("webglcontextlost");
    expect(dispose).not.toHaveBeenCalled();
  });

  it("rebuilds every resource on restore", () => {
    const { canvas, ctx } = make();
    let builds = 0;
    const h = ctx.register({ label: "a", create: () => ({ n: ++builds }) });
    expect(h.value).toEqual({ n: 1 });

    canvas.fire("webglcontextlost");
    canvas.fire("webglcontextrestored");

    expect(ctx.isLost).toBe(false);
    expect(h.alive).toBe(true);
    expect(h.value).toEqual({ n: 2 });
  });

  it("keeps the same handle across a cycle, so callers need no re-plumbing", () => {
    // Callers hold the handle and never the raw GL object. That is what
    // makes restore invisible to them.
    const { canvas, ctx } = make();
    const h = ctx.register({ label: "a", create: () => ({}) });
    const before = h;
    canvas.fire("webglcontextlost");
    canvas.fire("webglcontextrestored");
    expect(h).toBe(before);
  });

  it("survives a resource that fails to rebuild", () => {
    // Coming back with three of four passes working beats coming back
    // blank.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { canvas, ctx } = make();

    // Builds once at startup, then fails — a GPU that has come back with
    // less memory than it had, which is a real outcome of a driver reset.
    let builds = 0;
    ctx.register({
      label: "flaky",
      create: () => {
        if (builds++ > 0) throw new Error("out of memory");
        return {};
      },
    });
    const good = ctx.register({ label: "good", create: () => ({ ok: true }) });

    canvas.fire("webglcontextlost");
    expect(() => canvas.fire("webglcontextrestored")).not.toThrow();

    expect(good.alive).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("propagates a failure at first build rather than starting up half-broken", () => {
    // The asymmetry is deliberate. Failing to allocate at startup means
    // the app cannot run and the user should be told immediately; failing
    // during a restore is recoverable and best-effort.
    const { ctx } = make();
    expect(() =>
      ctx.register({
        label: "a",
        create: () => {
          throw new Error("no memory");
        },
      }),
    ).toThrow(/no memory/);
  });

  it("notifies the app on loss and on restore", () => {
    const onLost = vi.fn();
    const onRestored = vi.fn();
    const canvas = new MockCanvas(new MockGL());
    new GLContext(canvas as unknown as HTMLCanvasElement, { onLost, onRestored });

    canvas.fire("webglcontextlost");
    canvas.fire("webglcontextrestored");

    expect(onLost).toHaveBeenCalledOnce();
    expect(onRestored).toHaveBeenCalledOnce();
  });

  it("fires onRestored after resources are rebuilt, not before", () => {
    // The callback commonly redraws. Running it first would draw with
    // dead handles.
    let aliveWhenNotified: boolean | null = null;
    const canvas = new MockCanvas(new MockGL());
    const ctx = new GLContext(canvas as unknown as HTMLCanvasElement, {
      onRestored: () => {
        aliveWhenNotified = handle.alive;
      },
    });
    const handle = ctx.register({ label: "a", create: () => ({}) });

    canvas.fire("webglcontextlost");
    canvas.fire("webglcontextrestored");

    expect(aliveWhenNotified).toBe(true);
  });

  it("does not build a resource registered while the context is lost", () => {
    const { canvas, ctx } = make();
    canvas.fire("webglcontextlost");

    const h = ctx.register({ label: "late", create: () => ({}) });
    expect(h.alive).toBe(false);

    // But it is picked up by the next restore.
    canvas.fire("webglcontextrestored");
    expect(h.alive).toBe(true);
  });

  it("handles repeated loss/restore cycles", () => {
    const { canvas, ctx } = make();
    let builds = 0;
    const h = ctx.register({ label: "a", create: () => ({ n: ++builds }) });

    for (let i = 0; i < 5; i++) {
      canvas.fire("webglcontextlost");
      canvas.fire("webglcontextrestored");
    }
    expect(h.value).toEqual({ n: 6 });
    expect(ctx.isLost).toBe(false);
  });
});

describe("GLContext dispose", () => {
  it("removes its listeners", () => {
    // A playground that creates a new context per shader would otherwise
    // accumulate a listener per context and rebuild dead resources.
    const { canvas, ctx } = make();
    expect(canvas.listenerCount("webglcontextlost")).toBe(1);
    ctx.dispose();
    expect(canvas.listenerCount("webglcontextlost")).toBe(0);
    expect(canvas.listenerCount("webglcontextrestored")).toBe(0);
  });

  it("disposes live resources", () => {
    const dispose = vi.fn();
    const { ctx } = make();
    ctx.register({ label: "a", create: () => ({ id: 1 }), dispose });
    ctx.dispose();
    expect(dispose).toHaveBeenCalledWith(expect.anything(), { id: 1 });
  });

  it("is safe to call twice", () => {
    const dispose = vi.fn();
    const { ctx } = make();
    ctx.register({ label: "a", create: () => ({}), dispose });
    ctx.dispose();
    ctx.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("skips disposal when the context is already lost", () => {
    const dispose = vi.fn();
    const { canvas, ctx } = make();
    ctx.register({ label: "a", create: () => ({}), dispose });
    canvas.fire("webglcontextlost");
    ctx.dispose();
    expect(dispose).not.toHaveBeenCalled();
  });
});

describe("GLContext.describe", () => {
  it("falls back to the masked strings when debug_renderer_info is absent", () => {
    // Several browsers restrict or remove that extension as a
    // fingerprinting surface, so the unmasked strings are best-effort.
    const { ctx } = make();
    const info = ctx.describe();
    expect(info.vendor).toBe("Mock");
    expect(info.renderer).toBe("Mock Renderer");
    expect(info.version).toContain("WebGL 2.0");
  });
});
