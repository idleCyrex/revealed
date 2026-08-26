/* One question, asked once per page: is WebGL here real hardware, or a software
   rasterizer (SwiftShader/llvmpipe) that would run every fragment on the main
   thread's CPU budget? `failIfMajorPerformanceCaveat` is supposed to answer it,
   but current headless Chrome hands out SwiftShader contexts without raising
   the caveat, so the renderer string is the only reliable tell. */

let verdict: boolean | null = null;

/** True when a real GPU-backed WebGL context is available. Cached; SSR-safe
 *  (returns false with no DOM, and never touches `window` at module scope). */
export function hardwareGL(): boolean {
  if (verdict !== null) return verdict;
  if (typeof document === "undefined") return false; // do NOT cache: SSR only
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl", {
      failIfMajorPerformanceCaveat: true,
    }) as WebGLRenderingContext | null;
    if (!gl) return (verdict = false);
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return (verdict = !/swiftshader|llvmpipe|softpipe|software/i.test(renderer));
  } catch {
    return (verdict = false);
  }
}

/**
 * Whether `RevealField` will run its WebGL effect in this environment.
 * False on the server, without hardware WebGL, and under
 * `prefers-reduced-motion: reduce` — in every one of those cases the field
 * still renders its static front plate.
 */
export function isSupported(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  if (prefersReducedMotion()) return false;
  return hardwareGL();
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Push GL bring-up to browser idle so shader compilation does not compete with
 *  hydration or the page's own entrance animation. Returns a canceller. */
export function scheduleIdle(run: () => void, defer: boolean): () => void {
  if (!defer) {
    run();
    return () => {};
  }
  let cancelled = false;
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(
      () => {
        if (!cancelled) run();
      },
      { timeout: 1500 }
    );
    return () => {
      cancelled = true;
      if (typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(id);
      }
    };
  }
  const id = window.setTimeout(() => {
    if (!cancelled) run();
  }, 200);
  return () => {
    cancelled = true;
    window.clearTimeout(id);
  };
}
