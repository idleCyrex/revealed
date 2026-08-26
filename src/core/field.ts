import {
  createFullscreenTriangle,
  createTarget,
  linkProgram,
  loadImage,
  textureFromImage,
  type RenderTarget,
} from "./gl.js";
import {
  CapsuleQueue,
  createMaskPair,
  fillMaskPair,
  freeMaskPair,
  MASK_MAX,
  MASK_MIN,
  MAX_CAPSULES,
  MAX_POLY,
  type MaskPair,
} from "./mask.js";
import {
  imageKey,
  normalizeOptions,
  resolveImage,
  smallMaxWidth,
  smallSrc,
  type ResolvedOptions,
} from "./options.js";
import { MASK_FRAG } from "./shaders/mask.frag.js";
import { REDUCE_FRAG } from "./shaders/reduce.frag.js";
import { displayFrag, displayVariantKey } from "./shaders/display.frag.js";
import { VERTEX } from "./shaders/vertex.js";
import { hardwareGL, prefersReducedMotion, scheduleIdle } from "./support.js";
import { IdleStrokes } from "./strokes.js";
import type { ImageSource, RevealOptions } from "./types.js";
import type { MeshSkeletonHandle } from "../mesh/types.js";

/* per-60Hz-frame lerp amount k, rescaled to the real frame delta */
const fri = (k: number, dt: number) => 1 - Math.pow(1 - k, dt * 60);

/** how often the 1x1 reduction is read back and handed to `onReveal`, in ms.
 *  readPixels is a synchronous pipeline stall, so this is deliberately slow;
 *  the value is smoothed every frame, so consumers still see it move. */
const REVEAL_READ_MS = 100;

/** velocity a second of `wave.inject: 1` contact at full brush strength is
 *  worth. Fixed rather than exposed, because it only sets what the unit of
 *  `inject` MEANS: 4 puts a normal flick (about a fifth of a second) at the top
 *  of the encodable range, which is where the wave travels furthest without
 *  clipping a component. */
const INJECT_RATE = 4;

const PLATE_CSS =
  "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:fill;display:block;pointer-events:none;user-select:none;";

interface DisplayUniforms {
  front: WebGLUniformLocation | null;
  back: WebGLUniformLocation | null;
  mask: WebGLUniformLocation | null;
  skel: WebGLUniformLocation | null;
  texel: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  noise: WebGLUniformLocation | null;
  cut: WebGLUniformLocation | null;
  refract: WebGLUniformLocation | null;
  bubble: WebGLUniformLocation | null;
  maskPx: WebGLUniformLocation | null;
  progress: WebGLUniformLocation | null;
  skelColor: WebGLUniformLocation | null;
  skelAmp: WebGLUniformLocation | null;
  skelPeriod: WebGLUniformLocation | null;
}

interface MaskUniforms {
  prev: WebGLUniformLocation | null;
  seg: WebGLUniformLocation | null;
  amp: WebGLUniformLocation | null;
  r: WebGLUniformLocation | null;
  decay: WebGLUniformLocation | null;
  aspect: WebGLUniformLocation | null;
  texel: WebGLUniformLocation | null;
  advect: WebGLUniformLocation | null;
  spread: WebGLUniformLocation | null;
  inject: WebGLUniformLocation | null;
  swirl: WebGLUniformLocation | null;
  damp: WebGLUniformLocation | null;
}

interface Pen {
  x: number;
  y: number;
  has: boolean;
}

/**
 * Reveals one image out of another along a wet, noise-carved edge painted by
 * the pointer.
 *
 * The field owns everything it needs: it injects its own `<canvas>` plus the
 * two `<img>` plates that stand in whenever WebGL is unavailable, watches the
 * host for resizes, pauses itself off-screen and in hidden tabs, and frees all
 * of it in `destroy()`.
 */
export class RevealField {
  /* ---------------- public surface ---------------- */

  /** true while the WebGL effect is actually running on this field */
  get supported(): boolean {
    return this.glLive;
  }

  /** last measured 0..1 fraction of `measure` uncovered */
  get progress(): number {
    return this.lastFraction;
  }

  /* ---------------- host + DOM ---------------- */

  private host: HTMLElement;
  private canvas: HTMLCanvasElement | null = null;
  private frontImg: HTMLImageElement | null = null;
  private backImg: HTMLImageElement | null = null;
  private injected: Node[] = [];
  private hostStyleBefore = { position: "", aspectRatio: "", touchAction: "" };
  private ownsAspect = false;

  /* ---------------- options ---------------- */

  private raw: RevealOptions;
  private o: ResolvedOptions;
  private aspect = 1;

  /* ---------------- lifecycle ---------------- */

  private destroyed = false;
  private glLive = false;
  /** true once the canvas has a painted frame on it and has taken over from the
   *  static plate. Never set before the first successful `frame()`. */
  private glShown = false;
  private ready = false;
  private readyFired = false;
  /** set while we are the ones killing the context, so the loss handler that
   *  our own loseContext() triggers does not try to restore it */
  private tearingDown = false;
  private unschedule: (() => void) | null = null;

  /* ---------------- gl ---------------- */

  private gl: WebGLRenderingContext | null = null;
  private progDisplay: WebGLProgram | null = null;
  private progMask: WebGLProgram | null = null;
  private progReduce: WebGLProgram | null = null;
  private uD: DisplayUniforms | null = null;
  private uM: MaskUniforms | null = null;
  private uRRect: WebGLUniformLocation | null = null;
  private uRThreshold: WebGLUniformLocation | null = null;
  private quad: WebGLBuffer | null = null;
  private texFront: WebGLTexture | null = null;
  private texBack: WebGLTexture | null = null;
  /** null in the mesh path: the skeleton texture is the handle's, and the
   *  handle owns it. Deleting it here would free a texture we never made. */
  private texSkel: WebGLTexture | null = null;
  /** the handle currently brought up on this context, so a swapped-in handle is
   *  recognised even though neither has an image key to compare */
  private meshHandle: MeshSkeletonHandle | null = null;
  /** true only between a successful `mesh.create()` on the LIVE context and the
   *  next teardown. `this.gl` cannot stand in for it: a restored context is the
   *  same object, so identity would silently skip the re-create. */
  private meshLive = false;
  /** last `mode:period` pushed down to the handle, so the forward costs one
   *  string compare per bring-up rather than a re-render every frame */
  private meshTuning = "";
  private mask: MaskPair | null = null;
  private cur = 0;
  private reduceTarget: RenderTarget | null = null;
  private reducePx = new Uint8Array(4);
  private variantKey = "";
  /** applied to the mask as soon as it exists, for clear()/revealAll() calls
   *  that land before bring-up finishes */
  private pendingFill: number | null = null;

  /* ---------------- loop ---------------- */

  private raf = 0;
  private startT = 0;
  private lastFrameT = 0;
  /** decay is paid out in whole 1/255 steps so it never rounds away: at 144Hz
   *  one frame owes 0.63 of a step, which would quantise to a full step and
   *  shorten the trail window. Carrying the fraction makes the window exactly
   *  `brush.trail` at any refresh rate, with no dither and no float target.
   *  Held at 0 whenever `brush.healRate` is 0, so a persistent reveal never
   *  banks a debt that would be paid out the moment it is turned off. */
  private decayDebt = 0;
  /** performance.now() past which the velocity field is provably at rest, so a
   *  frame with nothing else to do can skip the mask pass entirely */
  private waveUntil = -1e9;
  private visible = true;
  private canvasW = 0;
  private canvasH = 0;

  /* ---------------- reveal measurement ---------------- */

  private rawFraction = 0;
  private smoothFraction = 0;
  private lastFraction = 0;
  private lastReadT = 0;

  /* ---------------- input ---------------- */

  private strokes: IdleStrokes;
  private caps = new CapsuleQueue();
  private live = { on: 0, tx: 0.5, ty: 0.5, s: 0 };
  private lastMoveT = -1e9;
  private path: number[] = [];
  private pen: Pen = { x: 0.5, y: 0.5, has: false };
  private apiPath: number[] = [];
  private apiPen: Pen = { x: 0.5, y: 0.5, has: false };
  private apiAmp = 1;
  private apiLastT = -1e9;
  private touchId: number | null = null;
  private pointerHost: HTMLElement | null = null;
  /** true while the `touch-action` on the pointer target is ours to give back */
  private ownsTouchAction = false;
  private hoverMq: MediaQueryList | null = null;
  /** smoothed skeleton strength: fast attack so a sweep lights the ghost at
   *  once, slow release so each pass fades like a wave */
  private skelS = 0;

  /* ---------------- observers ---------------- */

  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private motionMq: MediaQueryList | null = null;
  private smallMqs: MediaQueryList[] = [];

  constructor(host: HTMLElement, options: RevealOptions) {
    this.host = host;
    this.raw = { ...options };
    this.o = normalizeOptions(this.raw);
    this.aspect = this.o.aspect ?? 1;
    this.strokes = new IdleStrokes(this.o.idle);

    /* constructing without a DOM is a misuse, not a crash: the field simply
       does nothing, so an accidental server-side `new` cannot take a render
       down. Importing this module never touches window at all. */
    if (typeof window === "undefined" || typeof document === "undefined") {
      this.destroyed = true;
      return;
    }

    this.mountDom();
    this.watchEnvironment();
    this.scheduleBringUp();
  }

  /* ================================================================ *
   * DOM
   * ================================================================ */

  private mountDom(): void {
    const host = this.host;
    const cs = getComputedStyle(host);
    this.hostStyleBefore = {
      position: host.style.position,
      aspectRatio: host.style.aspectRatio,
      touchAction: host.style.touchAction,
    };
    if (cs.position === "static") host.style.position = "relative";
    /* only claim the aspect ratio if the page has not already decided one:
       a consumer sizing the host in CSS always wins */
    this.ownsAspect = cs.aspectRatio === "auto" || cs.aspectRatio === "";
    this.applyAspect();

    const back = this.makePlate(this.o.back);
    const front = this.makePlate(this.o.front);
    this.backImg = back.img;
    this.frontImg = front.img;
    /* the back plate is loaded but hidden: it is only ever shown by GL, and
       having it decoded means the reveal has nothing to wait for */
    back.img.style.visibility = "hidden";

    const canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;display:none;";
    canvas.setAttribute("aria-hidden", "true");
    this.canvas = canvas;

    /* prepended, and in this order, so that anything the consumer renders into
       the host (React children, a caption, a button) stays on top of all three */
    host.insertBefore(canvas, host.firstChild);
    host.insertBefore(front.node, canvas);
    host.insertBefore(back.node, front.node);
    this.injected = [back.node, front.node, canvas];

    front.img.addEventListener("load", this.onFrontLoad);
    if (front.img.complete && front.img.naturalWidth > 0) this.onFrontLoad();

    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    this.bindPointer();
  }

  private makePlate(src: ImageSource): { node: Node; img: HTMLImageElement } {
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    img.style.cssText = PLATE_CSS;
    const full = typeof src === "string" ? src : src.src;
    const small = smallSrc(src);
    const max = smallMaxWidth(src);
    img.src = full;
    if (small && max !== null) {
      /* a real <picture>, so the browser's own selection rules pick the plate
         and `resolveImage` picks the matching texture from the same rule */
      const pic = document.createElement("picture");
      const source = document.createElement("source");
      source.media = `(max-width: ${max}px)`;
      source.srcset = small;
      pic.appendChild(source);
      pic.appendChild(img);
      return { node: pic, img };
    }
    return { node: img, img };
  }

  private onFrontLoad = (): void => {
    const img = this.frontImg;
    if (!img || this.destroyed) return;
    if (this.o.aspect === null && img.naturalHeight > 0) {
      this.aspect = img.naturalWidth / img.naturalHeight;
      this.applyAspect();
    }
    /* where GL is never going to run there is no "first frame", so the decoded
       plate IS the finished presentation and ready means ready. Where it will
       run, the ready signal waits for it. */
    if (!this.glLive && !glPossible()) this.fireReady();
  };

  private applyAspect(): void {
    if (!this.ownsAspect) return;
    this.host.style.aspectRatio = String(this.aspect);
  }

  private setGlVisible(on: boolean): void {
    this.glShown = on;
    if (this.canvas) this.canvas.style.display = on ? "block" : "none";
    /* the front plate stays in the layout either way; hiding it rather than
       removing it means a context loss swaps back with no reflow */
    if (this.frontImg) this.frontImg.style.visibility = on ? "hidden" : "";
    if (this.host.classList) this.host.classList.toggle("revealed--gl", on);
  }

  /* ================================================================ *
   * environment
   * ================================================================ */

  private watchEnvironment(): void {
    if (window.matchMedia) {
      this.motionMq = window.matchMedia("(prefers-reduced-motion: reduce)");
      addMqListener(this.motionMq, this.onMotionChange);
      this.hoverMq = window.matchMedia("(hover: hover) and (pointer: fine)");
    }
    /* a viewport crossing a `smallMaxWidth` swaps the <picture> plate on its
       own; the textures have to be told */
    const maxes = new Set<number>();
    for (const s of [this.o.front, this.o.back, this.o.skeleton?.src]) {
      const m = s ? smallMaxWidth(s) : null;
      if (m !== null) maxes.add(m);
    }
    for (const m of maxes) {
      const mq = window.matchMedia(`(max-width: ${m}px)`);
      addMqListener(mq, this.onSmallChange);
      this.smallMqs.push(mq);
    }

    this.ro = new ResizeObserver(() => {
      this.resize();
      this.kick();
    });
    this.ro.observe(this.host);

    this.io = new IntersectionObserver(
      (entries) => {
        this.visible = entries[0]?.isIntersecting ?? true;
        this.kick();
      },
      { threshold: 0.01 }
    );
    this.io.observe(this.host);

    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("blur", this.onBlur);
  }

  private onMotionChange = (): void => {
    if (this.destroyed) return;
    if (prefersReducedMotion()) this.teardownGL();
    else this.scheduleBringUp();
  };

  private onSmallChange = (): void => {
    if (this.destroyed || !this.glLive) return;
    void this.loadTextures();
  };

  private onVisibility = (): void => {
    if (this.destroyed) return;
    if (document.hidden) this.strokes.pointer(false);
    this.kick();
  };

  private onBlur = (): void => {
    if (this.destroyed) return;
    this.strokes.pointer(false);
  };

  /* ================================================================ *
   * bring-up
   * ================================================================ */

  private scheduleBringUp(): void {
    if (this.destroyed || this.glLive || this.unschedule) return;
    if (prefersReducedMotion()) {
      /* not an error: a static front plate is exactly what was asked for */
      this.fireReadyIfPlateLoaded();
      return;
    }
    if (!hardwareGL()) {
      /* software GL would run this whole simulation on the CPU — the static
         plate is the better experience, but the consumer is told */
      this.fireReadyIfPlateLoaded();
      this.fireError("no hardware WebGL, using the static plate");
      return;
    }
    this.unschedule = scheduleIdle(() => {
      this.unschedule = null;
      this.bringUp();
    }, this.o.deferInit);
  }

  private fail(message: string): void {
    this.teardownGL();
    this.fireReadyIfPlateLoaded();
    this.fireError(message);
  }

  private fireReadyIfPlateLoaded(): void {
    const img = this.frontImg;
    if (img && img.complete && img.naturalWidth > 0) this.fireReady();
  }

  private bringUp(): void {
    if (this.destroyed || this.glLive) return;
    const canvas = this.canvas;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      /* every frame clears then draws the full triangle, and nothing ever reads
         the canvas back, so the buffer may swap instead of copy */
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
      failIfMajorPerformanceCaveat: true,
    }) as WebGLRenderingContext | null;
    if (!gl || gl.isContextLost()) {
      this.fail("could not create a WebGL context");
      return;
    }
    this.gl = gl;

    if (!this.buildPrograms()) {
      this.fail("shader link failed");
      return;
    }

    this.quad = createFullscreenTriangle(gl);
    if (!this.quad) {
      this.fail("vertex buffer allocation failed");
      return;
    }
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);

    /* fixed texture units, so no unit is ever reassigned mid-frame:
       0 = front, 1 = back, 2 = mask for display, 3 = mask for feedback and for
       the reduction, 4 = skeleton */
    gl.useProgram(this.progDisplay);
    gl.uniform1i(this.uD!.front, 0);
    gl.uniform1i(this.uD!.back, 1);
    gl.uniform1i(this.uD!.mask, 2);
    if (this.uD!.skel) gl.uniform1i(this.uD!.skel, 4);
    gl.useProgram(this.progMask);
    gl.uniform1i(this.uM!.prev, 3);
    gl.useProgram(this.progReduce);
    gl.uniform1i(gl.getUniformLocation(this.progReduce!, "uMask"), 3);

    /* 1x1 RGBA8 target the reduction writes its fraction into. If it cannot be
       made, the reveal read is simply skipped; the main effect is unaffected. */
    this.reduceTarget = createTarget(gl, 1, 1, gl.NEAREST);

    this.resize();
    /* the host may not be laid out yet; the ResizeObserver will size it up */
    if (!this.mask && !this.resizeMask(256, 256)) {
      this.fail("mask framebuffer allocation failed");
      return;
    }

    /* before loadTextures, not after: the mesh's target is transparent from the
       moment it exists, and unit 4 must never be left holding an INCOMPLETE
       texture — WebGL1 samples one as opaque BLACK, which would stamp the whole
       front plate dark. Synchronous, and it does not wait for the mesh itself. */
    this.syncMesh();

    void this.loadTextures(true);
  }

  private buildPrograms(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const variant = {
      skeleton: this.o.skeleton
        ? { source: this.o.skeleton.source, mode: this.o.skeleton.mode }
        : null,
    };
    const display = linkProgram(gl, VERTEX, displayFrag(variant));
    const mask = display ? linkProgram(gl, VERTEX, MASK_FRAG) : null;
    const reduce = mask ? linkProgram(gl, VERTEX, REDUCE_FRAG) : null;
    if (!display || !mask || !reduce) {
      if (display) gl.deleteProgram(display);
      if (mask) gl.deleteProgram(mask);
      return false;
    }
    if (this.progDisplay) gl.deleteProgram(this.progDisplay);
    if (this.progMask) gl.deleteProgram(this.progMask);
    if (this.progReduce) gl.deleteProgram(this.progReduce);
    this.progDisplay = display;
    this.progMask = mask;
    this.progReduce = reduce;
    this.variantKey = displayVariantKey(variant);

    const u = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
    this.uD = {
      front: u(display, "uFront"),
      back: u(display, "uBack"),
      mask: u(display, "uMask"),
      skel: u(display, "uSkel"),
      texel: u(display, "uTexel"),
      time: u(display, "uTime"),
      noise: u(display, "uNoise"),
      cut: u(display, "uCut"),
      refract: u(display, "uRefract"),
      bubble: u(display, "uBubble"),
      maskPx: u(display, "uMaskPx"),
      progress: u(display, "uProgress"),
      skelColor: u(display, "uSkelColor"),
      skelAmp: u(display, "uSkelAmp"),
      skelPeriod: u(display, "uSkelPeriod"),
    };
    this.uM = {
      prev: u(mask, "uPrev"),
      seg: u(mask, "uSeg"),
      amp: u(mask, "uAmp"),
      r: u(mask, "uR"),
      decay: u(mask, "uDecay"),
      aspect: u(mask, "uAspect"),
      texel: u(mask, "uTexel"),
      advect: u(mask, "uAdvect"),
      spread: u(mask, "uSpread"),
      inject: u(mask, "uInject"),
      swirl: u(mask, "uSwirl"),
      damp: u(mask, "uDamp"),
    };
    this.uRRect = u(reduce, "uRect");
    this.uRThreshold = u(reduce, "uThreshold");
    return true;
  }

  /** (Re)load the three plates as textures. `first` also brings the field live. */
  private async loadTextures(first = false): Promise<void> {
    const gl = this.gl;
    if (!gl) return;
    const w = window.innerWidth;
    const urls = [
      resolveImage(this.o.front, w),
      resolveImage(this.o.back, w),
      this.o.skeleton?.src ? resolveImage(this.o.skeleton.src, w) : null,
    ];
    let images: (HTMLImageElement | null)[];
    try {
      images = await Promise.all(
        urls.map((u) => (u ? loadImage(u) : Promise.resolve(null)))
      );
    } catch (err) {
      /* a 404 on a plate is the consumer's bug, but it must not leave a blank
         canvas over the page: fall back to the static plates */
      this.fail((err as Error).message ?? "image load failed");
      return;
    }
    if (this.destroyed || this.gl !== gl || gl.isContextLost()) return;

    const made = images.map((img) => (img ? textureFromImage(gl, img) : null));
    if (!made[0] || !made[1] || (urls[2] && !made[2])) {
      for (const t of made) if (t) gl.deleteTexture(t);
      this.fail("texture allocation failed");
      return;
    }

    if (this.texFront) gl.deleteTexture(this.texFront);
    if (this.texBack) gl.deleteTexture(this.texBack);
    if (this.texSkel) gl.deleteTexture(this.texSkel);
    this.texFront = made[0];
    this.texBack = made[1];
    this.texSkel = made[2];

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texFront);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texBack);
    if (this.texSkel) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.texSkel);
    } else {
      /* an image skeleton may have just been swapped out for a mesh one, and
         this is the call that dropped its texture — unit 4 is now stale */
      this.syncMesh();
    }

    if (this.o.aspect === null && images[0] && images[0].naturalHeight > 0) {
      this.aspect = images[0].naturalWidth / images[0].naturalHeight;
      this.applyAspect();
    }

    if (first) {
      this.ready = true;
      this.glLive = true;
      this.startT = performance.now();
      this.lastFrameT = this.startT;
      this.resize();
      /* frame() is what swaps the static plate for the canvas, and only once it
         has actually painted one: a host with no layout yet (inside a collapsed
         panel, or a tab that has never been rendered) makes the first frame a
         no-op, and hiding the plate before that would leave the host blank */
      this.frame(this.startT);
      this.fireReady();
      /* one frame of the reveal is already up, so a sweep from here on lands on
         something that can show it */
      if (this.o.idle.enabled) this.strokes.arm();
      this.kick();
    } else {
      this.kick();
    }
  }

  /* both callbacks are deferred by a microtask: bring-up can conclude
     synchronously inside the constructor (a cached plate, or no WebGL at all),
     and a consumer must never be called back before `new RevealField()` has
     returned them the instance */
  private fireReady(): void {
    if (this.readyFired || this.destroyed) return;
    this.readyFired = true;
    const cb = this.o.onReady;
    if (cb) defer(() => !this.destroyed && cb());
  }

  private fireError(message: string): void {
    const cb = this.o.onError;
    if (cb) defer(() => !this.destroyed && cb(new Error(`revealed: ${message}`)));
  }

  /* ================================================================ *
   * sizing
   * ================================================================ */

  private resize(): void {
    const gl = this.gl;
    const canvas = this.canvas;
    if (!gl || !canvas) return;
    const cw = this.host.clientWidth;
    const ch = this.host.clientHeight;
    if (cw < 1 || ch < 1) return;
    /* capped (1.5 by default) rather than uncapped: the display pass runs two
       5-octave fbm evaluations per pixel, and 1.5 cuts the pixel count ~44% on
       hiDPI with no visible loss on an effect this soft */
    const dpr = Math.min(window.devicePixelRatio || 1, this.o.maxDpr);
    const w = Math.round(cw * dpr);
    const h = Math.round(ch * dpr);
    if (w !== this.canvasW || h !== this.canvasH) {
      this.canvasW = w;
      this.canvasH = h;
      canvas.width = w;
      canvas.height = h;
    }
    this.syncMaskSize();
    /* the mesh target follows the plate, and only its RATIO and its own cap
       matter. `resize` early-returns on an unchanged size, and the texture
       OBJECT survives a re-spec, so unit 4 never needs rebinding for this —
       which is the whole reason it is safe to call every frame. */
    if (this.meshLive && w > 0 && h > 0) {
      this.o.skeleton?.mesh?.resize(w, h);
    }
  }

  /* ================================================================ *
   * mesh skeleton
   * ================================================================ */

  /** Bring the caller's mesh handle up on this context and bind it to unit 4,
   *  or take a departed one down. Never creates the handle and never destroys
   *  it: the caller owns that. Idempotent, and safe to call before, during and
   *  after bring-up.
   *
   *  `create()` is both the first-time call and the context-restore call, and
   *  it is the one place the handle's texture changes identity — so the bind
   *  below sits immediately after it and nowhere else. */
  private syncMesh(): void {
    const want = this.o.skeleton?.mesh ?? null;
    if (want !== this.meshHandle) {
      /* a different handle is a different set of GL objects; the old one is the
         caller's to destroy, so all we drop is our claim on it */
      this.meshHandle = want;
      this.meshLive = false;
      this.meshTuning = "";
    }
    const gl = this.gl;
    if (!gl || !want || gl.isContextLost()) return;

    if (!this.meshLive) {
      /* false means not even a 1x1 fallback could be made. Binding null then is
         still correct: an unbound unit 4 samples transparent, whereas a texture
         with no image samples opaque black. Either way the reveal runs. */
      want.create(gl);
      this.meshLive = true;
      this.meshTuning = "";
    }
    if (this.canvasW > 0 && this.canvasH > 0) {
      want.resize(this.canvasW, this.canvasH);
    }
    /* `skeleton.mode`/`period` are the single source of truth: the display pass
       and the mesh's own scan band are two halves of one animation, and letting
       them disagree is exactly the "two animations fighting" failure. Pushed
       only on change — setOptions marks the handle dirty, so doing it per frame
       would force a redraw of a wireframe that had not moved. */
    const sk = this.o.skeleton!;
    const tuning = `${sk.mode}:${sk.period}`;
    if (tuning !== this.meshTuning) {
      this.meshTuning = tuning;
      want.setOptions({ mode: sk.mode, period: sk.period });
    }

    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, want.texture);
  }

  /** Step and redraw the wireframe, before the display pass samples it. The
   *  handle saves and restores every piece of GL state it touches, so this can
   *  sit anywhere in the frame; `dirty` is what keeps a settled pose from
   *  costing a draw. */
  private runMesh(dt: number): void {
    const mesh = this.o.skeleton?.mesh;
    if (!mesh || !this.meshLive) return;
    /* -1..1, y DOWN, which is the convention the plate's uv already uses.
       Null while the pointer is away, and the pose eases back to neutral. */
    const p =
      this.live.on === 1
        ? { x: this.live.tx * 2 - 1, y: this.live.ty * 2 - 1 }
        : null;
    mesh.update(dt, p);
    if (mesh.dirty) mesh.render();
  }

  /** The mask's own cap. With the wave on it is `brush.wave.resolution` rather
   *  than MASK_MAX: the pass is now six taps instead of one, several of them
   *  dependent, which is the worst shape there is for a tile-based integrated
   *  GPU — and a coarser field is what MAKES the faceted tear, so the cheap
   *  choice is also the better-looking one. Live through `setOptions`, at the
   *  same cost class as a resize, which is exactly what it is. */
  private syncMaskSize(): void {
    const w = this.canvasW;
    const h = this.canvasH;
    if (w < 1 || h < 1) return;
    const wave = this.o.brush.wave;
    const cap = wave.enabled ? Math.min(MASK_MAX, wave.resolution) : MASK_MAX;
    const s = Math.min(1, cap / Math.max(w, h));
    const nw = Math.max(MASK_MIN, Math.round(w * s));
    const nh = Math.max(MASK_MIN, Math.round(h * s));
    if (!this.mask || nw !== this.mask.w || nh !== this.mask.h) {
      this.resizeMask(nw, nh);
    }
  }

  /** Resize keeps the trail: the old mask is resampled into the new pair with
   *  one draw of the same feedback shader (decay 0, brush 0), so a window
   *  resize mid-stroke cannot flash the reveal away. Failing to allocate the
   *  new pair leaves the old one in place rather than dropping the effect. */
  private resizeMask(w: number, h: number): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const next = createMaskPair(gl, w, h);
    if (!next) return false;
    const old = this.mask;
    if (old && this.progMask && this.uM) {
      gl.useProgram(this.progMask);
      gl.uniform4f(this.uM.seg, 0, 0, 0, 0);
      gl.uniform1f(this.uM.amp, 0);
      gl.uniform1f(this.uM.r, this.o.brush.radius);
      gl.uniform1f(this.uM.decay, 0);
      gl.uniform1f(this.uM.aspect, this.aspect);
      /* neutral wave: a pure resample. uDamp 1 keeps the velocity field, which
         survives the resize the same way the reveal does, so a window resize
         mid-wave cannot stop it dead any more than it flashes the reveal away */
      gl.uniform2f(this.uM.texel, 1 / w, 1 / h);
      gl.uniform1f(this.uM.advect, 0);
      gl.uniform1f(this.uM.spread, 0);
      gl.uniform1f(this.uM.inject, 0);
      gl.uniform1f(this.uM.swirl, 0);
      gl.uniform1f(this.uM.damp, 1);
      gl.viewport(0, 0, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, next.fbo[this.cur]);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, old.tex[this.cur]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    freeMaskPair(gl, old);
    this.mask = next;
    if (this.pendingFill !== null) {
      fillMaskPair(gl, next, this.pendingFill);
      this.pendingFill = null;
    }
    return true;
  }

  /* ================================================================ *
   * pointer
   * ================================================================ */

  private bindPointer(): void {
    const target = this.o.pointerTarget ?? this.host;
    if (this.pointerHost === target) return;
    this.unbindPointer();
    this.pointerHost = target;
    /* vertical pans stay with the browser and scroll the page (which fires
       pointercancel and cleanly ends the stroke); sideways movement is ours.
       Only claimed when the page has not set one, and given back on unbind */
    this.ownsTouchAction = !target.style.touchAction;
    if (this.ownsTouchAction) target.style.touchAction = "pan-y";
    target.addEventListener("pointermove", this.onPointerMove);
    target.addEventListener("pointerenter", this.onPointerMove);
    target.addEventListener("pointerleave", this.onPointerLeave);
    target.addEventListener("pointerdown", this.onPointerDown);
    target.addEventListener("pointerup", this.onPointerUp);
    target.addEventListener("pointercancel", this.onPointerUp);
  }

  private unbindPointer(): void {
    const t = this.pointerHost;
    if (!t) return;
    t.removeEventListener("pointermove", this.onPointerMove);
    t.removeEventListener("pointerenter", this.onPointerMove);
    t.removeEventListener("pointerleave", this.onPointerLeave);
    t.removeEventListener("pointerdown", this.onPointerDown);
    t.removeEventListener("pointerup", this.onPointerUp);
    t.removeEventListener("pointercancel", this.onPointerUp);
    if (this.ownsTouchAction) t.style.touchAction = "";
    this.ownsTouchAction = false;
    this.pointerHost = null;
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.destroyed || !this.glLive) return;
    /* touch has no hover to enter with, so a stroke lives from finger-down to
       finger-up; a fine pointer paints on hover alone */
    if (!(this.hoverMq?.matches ?? true) && this.touchId === null) return;
    const r = this.host.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const now = performance.now();
    /* the browser batches pointermoves to the frame; replaying the coalesced
       samples gives the brush the real path, not just its endpoints */
    const coalesced =
      typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const samples: PointerEvent[] = coalesced.length ? coalesced : [e];
    for (const p of samples) {
      const nx = (p.clientX - r.left) / r.width;
      const ny = (p.clientY - r.top) / r.height;
      if (
        Math.abs(nx - this.live.tx) > 0.001 ||
        Math.abs(ny - this.live.ty) > 0.001
      ) {
        this.lastMoveT = now;
      }
      this.live.tx = nx;
      this.live.ty = ny;
      if (this.live.on === 0) {
        /* entering: start the stroke here, do not draw in from wherever the
           previous stroke happened to end */
        this.path.length = 0;
        this.pen.x = nx;
        this.pen.y = ny;
        this.pen.has = true;
        this.live.on = 1;
      }
      this.path.push(nx, ny);
    }
    this.live.on = 1;
    this.strokes.pointer(true);
    if (this.path.length > 512) this.path.splice(0, this.path.length - 512);
    this.kick();
  };

  private onPointerLeave = (): void => {
    /* stop adding brush; what is already in the mask heals on its own, or stays
       exactly as painted while `brush.persist` is on */
    this.live.on = 0;
    this.live.s = 0;
    this.pen.has = false;
    this.path.length = 0;
    this.strokes.pointer(false);
  };

  private onPointerDown = (e: PointerEvent): void => {
    if ((this.hoverMq?.matches ?? false) || e.pointerType === "mouse") return;
    this.touchId = e.pointerId;
    this.onPointerMove(e);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.touchId === null || e.pointerId !== this.touchId) return;
    this.touchId = null;
    this.onPointerLeave();
  };

  /* ================================================================ *
   * loop
   * ================================================================ */

  private get shouldRun(): boolean {
    return (
      !this.destroyed &&
      this.ready &&
      this.glLive &&
      this.o.running &&
      this.visible &&
      !document.hidden
    );
  }

  private kick(): void {
    if (this.raf || !this.shouldRun) return;
    /* the loop was stopped, so its clock and its decay debt are stale */
    this.lastFrameT = performance.now();
    this.decayDebt = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (ts: number): void => {
    this.raf = 0;
    if (!this.shouldRun) return;
    this.frame(ts);
    this.raf = requestAnimationFrame(this.tick);
  };

  private frame(now: number): void {
    if (!this.gl || !this.uM || !this.uD || this.destroyed) return;
    /* resize FIRST: it can replace the mask pair, so nothing may hold a
       reference to it from before this call */
    this.resize();
    if (!this.mask || this.canvasW < 1 || this.canvasH < 1) return;

    const t = (now - this.startT) * 0.001;
    /* real delta so 60/120/144Hz run at the same speed; clamped so a hitch, a
       hidden tab or an off-screen pause cannot jump the trail, and floored at 0
       because kick() stamps the clock with performance.now() while the frame
       carries the slightly earlier time it began */
    const dt = Math.min(Math.max((now - this.lastFrameT) / 1000, 0), 1 / 30);
    this.lastFrameT = now;

    this.caps.reset();
    this.collectIdle(now);
    this.collectApi(now);
    this.collectPointer(now, dt);

    const decay = this.payDecay(dt);
    this.runMaskPasses(decay, now, dt);
    this.runReduce(now);
    /* before the display pass, which samples the target it writes */
    this.runMesh(dt);
    this.runDisplay(t, dt);
    /* the canvas now HAS a frame, so it is safe to hide the static plate behind
       it. Doing it here rather than at bring-up means a host that was not laid
       out yet keeps showing its plate until there is something to replace it */
    if (!this.glShown) this.setGlVisible(true);
  }

  /* Idle strokes take their slots first: each owes exactly one capsule per
     frame and cannot be subsampled, whereas the pointer polyline can.
     Sampled even with the autopilot off, because the same call is what expires
     a stale pointer report — with it skipped, a pointerleave that never fired
     would pin the skeleton on for good. */
  private collectIdle(now: number): void {
    const r = this.o.brush.radius;
    for (const s of this.strokes.sample(now)) {
      if (!s.on) continue;
      this.caps.push(s.px, s.py, s.x, s.y, 1, r * s.r);
    }
  }

  private collectApi(now: number): void {
    if (this.apiPath.length === 0) return;
    /* consecutive paint() calls inside a short window are one stroke, so a
       scripted path is continuous the way a pointer path is; a lone call after
       a gap is a single dab */
    if (now - this.apiLastT > 200) this.apiPen.has = false;
    this.apiLastT = now;
    const budget = Math.max(1, MAX_CAPSULES - this.caps.n - 1);
    this.emitPolyline(this.apiPath, this.apiPen, this.apiAmp, budget);
    this.apiPath.length = 0;
  }

  private collectPointer(now: number, dt: number): void {
    if (this.live.on !== 1) {
      this.live.s += (0 - this.live.s) * fri(0.12, dt);
      return;
    }
    /* paint only while actually moving; holding still lets the mark fade out
       with the rest of the trail. Fast attack / slow release so re-engaging
       after a pause is instant.
       `spotlight` is exempt: there is no trail for a held mark to fade into,
       and the mode's contract is that the reveal is wherever the pointer IS —
       which a still pointer still has. It goes out when the pointer leaves,
       not when it stops. */
    const moving =
      this.o.brush.spotlight || now - this.lastMoveT < this.o.brush.holdTimeout;
    this.live.s +=
      ((moving ? 1 : 0) - this.live.s) * fri(moving ? 0.4 : 0.12, dt);
    const amp = this.live.s;
    if (this.path.length > 0) {
      const budget = Math.max(
        1,
        Math.min(MAX_POLY, MAX_CAPSULES - this.caps.n - 1)
      );
      this.emitPolyline(this.path, this.pen, amp, budget);
      this.path.length = 0;
    } else if (this.pen.has && amp > 0.01) {
      /* no new samples this frame: keep the head alive as a degenerate capsule,
         which is a disc, until the strength decays away */
      this.caps.push(
        this.pen.x,
        this.pen.y,
        this.pen.x,
        this.pen.y,
        amp,
        this.o.brush.radius
      );
    }
  }

  /** Draw a path as a polyline of capsules, starting from the pen so the stroke
   *  is continuous however far the pointer jumped. Subsampling loses a little
   *  curvature and NEVER any continuity. */
  private emitPolyline(
    path: number[],
    pen: Pen,
    amp: number,
    budget: number
  ): void {
    const n = path.length / 2;
    if (n === 0) return;
    if (!pen.has) {
      pen.x = path[0];
      pen.y = path[1];
      pen.has = true;
    }
    const stride = Math.ceil(n / budget);
    let ax = pen.x;
    let ay = pen.y;
    const r = this.o.brush.radius;
    for (let i = stride - 1; i < n; i += stride) {
      const bx = path[i * 2];
      const by = path[i * 2 + 1];
      this.caps.push(ax, ay, bx, by, amp, r);
      ax = bx;
      ay = by;
    }
    const lx = path[(n - 1) * 2];
    const ly = path[(n - 1) * 2 + 1];
    if (ax !== lx || ay !== ly) this.caps.push(ax, ay, lx, ly, amp, r);
    pen.x = lx;
    pen.y = ly;
  }

  /** whole 1/255 steps only, fraction carried: the trail window is exact at any
   *  refresh rate. `healRate` 0 (i.e. `brush.persist`) owes exactly zero, and
   *  banks nothing while it is on, so no carried fraction can mature into a
   *  step the moment the option is turned back off. */
  private payDecay(dt: number): number {
    const rate = this.o.brush.healRate;
    if (!(rate > 0)) {
      this.decayDebt = 0;
      return 0;
    }
    /* the other end: `healRate: Infinity`, i.e. `brush.spotlight`. The whole
       mask is owed every frame and there is no fraction left to carry, which is
       the limit of the arithmetic below rather than a different rule — but it
       has to be written down, because that arithmetic goes through 1/(rate*255)
       and would evaluate 0/0 on any frame with a zero delta (the first frame
       after a kick has exactly that) and poison the carried debt with a NaN. */
    if (rate === Infinity) {
      this.decayDebt = 0;
      return 1;
    }
    /* seconds per 1/255 step: the reciprocal of the rate, spread over 255 */
    const lsb = 1 / (rate * 255);
    this.decayDebt += dt;
    let steps = Math.floor(this.decayDebt / lsb);
    if (steps > 255) {
      steps = 255;
      this.decayDebt = 0;
    } else {
      this.decayDebt -= steps * lsb;
    }
    return steps / 255;
  }

  /** How long a stroke's momentum can still be moving the field, in seconds:
   *  the time for the fastest encodable velocity to damp below one encoding
   *  step, where the pass snaps it to exactly zero and everything stops. Past
   *  that, a frame with no capsules and no decay owed has provably nothing to
   *  do, and the pass is skipped exactly as it was before the wave. */
  private waveLife(): number {
    const w = this.o.brush.wave;
    if (!w.enabled) return 0;
    const d = w.damping;
    /* damping 0 kills the field on the very next frame; otherwise it is the
       number of e-folds from VMAX (0.8) down to one step (2/255), plus the
       spread's own bounded range, which outlives nothing else here */
    const decayLife = d > 0 ? Math.log(0.8 / (2 / 255)) / Math.log(1 / d) : 0;
    return Math.min(12, Math.max(decayLife, w.spread > 0 ? 2 : 0.05));
  }

  private runMaskPasses(decay: number, now: number, dt: number): void {
    const gl = this.gl!;
    const mask = this.mask!;
    const u = this.uM!;
    const wave = this.o.brush.wave;
    const n = this.caps.n;
    /* a capsule with any strength at all has stirred the field, so the wave has
       to keep being stepped for as long as that stir can still be moving */
    if (n > 0 && wave.enabled) {
      for (let i = 0; i < n; i++) {
        if (this.caps.amp[i] > 0) {
          this.waveUntil = now + this.waveLife() * 1000;
          break;
        }
      }
    }
    const waveLive = wave.enabled && now < this.waveUntil;
    const passes = n > 0 ? n : decay > 0 || waveLive ? 1 : 0;
    if (passes === 0) return;

    /* advection is uv-per-frame, so the real delta is folded in here and the
       shader carries no clock of its own. The rest are per-frame amounts too:
       damping is a per-second survival rescaled to the frame, and the spread is
       a per-second uv creep rescaled to the frame AND to the mask's own texel
       size, so all three are frame-rate independent by construction. */
    const advect = waveLive ? wave.advect * dt : 0;
    const damp = waveLive ? Math.pow(wave.damping, dt) : 1;
    const spread = waveLive
      ? Math.min(0.5, wave.spread * dt * mask.h)
      : 0;
    /* injection is a RATE, not a per-frame constant: the pass adds it every
       frame the pointer is down, so a per-frame constant would saturate the
       whole brush disc at VMAX inside one frame and hand the back-trace a
       flat-topped plateau with a shear wall around it, which tears the reveal
       apart in well under a second. INJECT_RATE sets what a second of
       full-strength contact is worth, so ~0.2 s of stroke arrives at about
       0.8 — the top of the encodable range — and gets there along the brush's
       own profile instead of clipping to it. The clamp stops a 20 Hz hitch
       from throwing one enormous splat. */
    const inject = wave.enabled
      ? wave.inject * INJECT_RATE * Math.min(dt, 1 / 30)
      : 0;

    gl.useProgram(this.progMask);
    gl.viewport(0, 0, mask.w, mask.h);
    gl.uniform1f(u.aspect, this.aspect);
    gl.uniform2f(u.texel, 1 / mask.w, 1 / mask.h);
    gl.uniform1f(u.inject, inject);
    gl.uniform1f(u.swirl, wave.swirl);
    gl.activeTexture(gl.TEXTURE3);
    for (let i = 0; i < passes; i++) {
      /* the frame's decay, advection, spread and damping are each owed ONCE,
         not once per capsule: seven capsules must not transport the field seven
         times. Only the capsule's own brush and velocity injection are per
         pass, and with these four neutral the pass reduces to exactly the
         `max` it was before the wave. */
      const first = i === 0;
      gl.uniform1f(u.decay, first ? decay : 0);
      gl.uniform1f(u.advect, first ? advect : 0);
      gl.uniform1f(u.spread, first ? spread : 0);
      gl.uniform1f(u.damp, first ? damp : 1);
      if (n > 0) {
        const o = i * 4;
        gl.uniform1f(u.amp, this.caps.amp[i]);
        gl.uniform1f(u.r, this.caps.rad[i]);
        gl.uniform4f(
          u.seg,
          this.caps.seg[o] * this.aspect,
          this.caps.seg[o + 1],
          (this.caps.seg[o + 2] - this.caps.seg[o]) * this.aspect,
          this.caps.seg[o + 3] - this.caps.seg[o + 1]
        );
      } else {
        gl.uniform1f(u.amp, 0);
        gl.uniform1f(u.r, this.o.brush.radius);
        gl.uniform4f(u.seg, 0, 0, 0, 0);
      }
      /* reads cur, writes the other: never the same texture in one draw */
      gl.bindFramebuffer(gl.FRAMEBUFFER, mask.fbo[1 - this.cur]);
      gl.bindTexture(gl.TEXTURE_2D, mask.tex[this.cur]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.cur = 1 - this.cur;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private runReduce(now: number): void {
    const target = this.reduceTarget;
    if (now - this.lastReadT >= REVEAL_READ_MS) {
      this.lastReadT = now;
      /* if the 1x1 target could not be made, the read is simply skipped and the
         fraction rides on `progress` alone; the main effect is unaffected */
      if (target) {
        const gl = this.gl!;
        gl.useProgram(this.progReduce);
        gl.viewport(0, 0, 1, 1);
        const m = this.o.measure;
        gl.uniform4f(this.uRRect, m.x0, m.y0, m.x1, m.y1);
        gl.uniform1f(this.uRThreshold, this.o.edge.threshold);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, this.mask!.tex[this.cur]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.reducePx);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.rawFraction = this.reducePx[0] / 255;
      }
      /* the forced floor never touches the mask, so it is folded in here. The
         progress dissolve sweeps area roughly linearly by construction, which
         makes `progress` itself a good estimate of the area it uncovered. */
      const f = Math.max(this.smoothFraction, this.o.progress);
      this.lastFraction = f;
      this.o.onReveal?.(f);
    }
    /* smoothed every frame even though it is read ten times a second, so a
       consumer reading `.progress` per frame sees it glide rather than step.
       The approach is asymptotic, so it is snapped once it is inside a fifth of
       the reducer's own 1/100 resolution: with `brush.persist` the fraction only
       ever rises, and a consumer waiting on `f === 1` must actually get it. */
    this.smoothFraction += (this.rawFraction - this.smoothFraction) * 0.08;
    if (Math.abs(this.rawFraction - this.smoothFraction) < 0.002) {
      this.smoothFraction = this.rawFraction;
    }
  }

  private runDisplay(t: number, dt: number): void {
    const gl = this.gl!;
    const mask = this.mask!;
    const u = this.uD!;
    const e = this.o.edge;

    gl.useProgram(this.progDisplay);
    gl.viewport(0, 0, this.canvasW, this.canvasH);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, mask.tex[this.cur]);
    gl.uniform2f(u.texel, 1 / mask.w, 1 / mask.h);
    gl.uniform1f(u.time, t);
    gl.uniform3f(u.noise, e.scale, e.carve, e.detail);
    gl.uniform3f(u.cut, e.threshold, e.feather, e.speed);
    gl.uniform2f(u.refract, e.refraction, e.refractionFalloff);
    gl.uniform3f(u.bubble, e.bubble, e.bubbleScale, e.facet);
    gl.uniform2f(u.maskPx, mask.w, mask.h);
    gl.uniform1f(u.progress, this.o.progress);

    const sk = this.o.skeleton;
    if (sk && u.skelAmp) {
      /* the skeleton rides the strokes: activity is 1 under the pointer and a
         mid-sweep hump for each idle stroke, so the ghost waves in and out with
         the reveal and all but vanishes on a still, untouched field */
      const act = this.strokes.activity();
      this.skelS +=
        (act - this.skelS) * fri(act > this.skelS ? 0.16 : 0.045, dt);
      const reactive = sk.reactive ? 0.111 + 0.889 * this.skelS : 1;
      gl.uniform1f(u.skelAmp, sk.opacity * reactive);
      gl.uniform3f(u.skelColor, sk.color[0], sk.color[1], sk.color[2]);
      gl.uniform1f(u.skelPeriod, sk.period);
    }

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ================================================================ *
   * context loss
   * ================================================================ */

  private onContextLost = (e: Event): void => {
    /* preventDefault is what makes a restore possible at all */
    e.preventDefault();
    if (this.tearingDown) return;
    this.teardownGL();
  };

  private onContextRestored = (): void => {
    if (this.destroyed || this.tearingDown) return;
    this.scheduleBringUp();
  };

  /* ================================================================ *
   * public API
   * ================================================================ */

  /** Merge new options. Image sources and skeleton shape reload or relink;
   *  every numeric tunable is a uniform and takes effect on the next frame. */
  setOptions(next: Partial<RevealOptions>): void {
    if (this.destroyed) return;
    const before = this.o;
    this.raw = { ...this.raw, ...next };
    this.o = normalizeOptions(this.raw);
    const o = this.o;

    /* the carried fraction is denominated in the OLD step size, so a changed
       heal rate makes it meaningless: drop it and let the next frame start the
       window clean. Toggling `persist` is exactly this case, which is why it is
       live — freezing and resuming touch no GL state at all. */
    if (o.brush.healRate !== before.brush.healRate) this.decayDebt = 0;
    /* turning the wave off must stop it NOW, not once the field would have
       damped out on its own; turning it on lets the next stroke arm it */
    if (!o.brush.wave.enabled) this.waveUntil = -1e9;
    /* every wave control is a uniform except the resolution, which reallocates
       the pair — the same cost class as a resize, and handled by the same code.
       Done here rather than left to the next frame so it lands on a paused,
       hidden or off-screen field too. */
    if (
      this.glLive &&
      (o.brush.wave.resolution !== before.brush.wave.resolution ||
        o.brush.wave.enabled !== before.brush.wave.enabled)
    ) {
      this.syncMaskSize();
    }

    if (o.aspect !== null) this.aspect = o.aspect;
    else if (before.aspect !== null && this.frontImg?.naturalHeight) {
      this.aspect = this.frontImg.naturalWidth / this.frontImg.naturalHeight;
    }
    this.applyAspect();

    this.strokes.setOptions(o.idle);
    if (o.idle.enabled && this.glLive) this.strokes.arm();

    if ((o.pointerTarget ?? this.host) !== this.pointerHost) this.bindPointer();

    const platesChanged =
      imageKey(o.front) !== imageKey(before.front) ||
      imageKey(o.back) !== imageKey(before.back) ||
      imageKey(o.skeleton?.src) !== imageKey(before.skeleton?.src);
    if (platesChanged) this.reloadPlates();

    if (this.glLive) {
      /* only the SHAPE of the skeleton branch is baked into the program; its
         colour, opacity and period are uniforms and never relink */
      const wantKey = displayVariantKey({
        skeleton: o.skeleton
          ? { source: o.skeleton.source, mode: o.skeleton.mode }
          : null,
      });
      if (wantKey !== this.variantKey) {
        if (this.buildPrograms()) {
          const gl = this.gl!;
          gl.useProgram(this.progDisplay);
          gl.uniform1i(this.uD!.front, 0);
          gl.uniform1i(this.uD!.back, 1);
          gl.uniform1i(this.uD!.mask, 2);
          if (this.uD!.skel) gl.uniform1i(this.uD!.skel, 4);
          gl.useProgram(this.progMask);
          gl.uniform1i(this.uM!.prev, 3);
          gl.useProgram(this.progReduce);
          gl.uniform1i(gl.getUniformLocation(this.progReduce!, "uMask"), 3);
        } else {
          this.fail("shader relink failed");
          return;
        }
      }
      if (!platesChanged && o.skeleton?.src && !before.skeleton) {
        /* an IMAGE skeleton was added without changing the other two plates.
           A mesh one has nothing to load: syncMesh below is the whole job. */
        void this.loadTextures();
      }
      /* after the relink, so the `uSkel` unit assignment it re-uploads is
         already in place, and after any reload that may have freed a texture
         off unit 4 */
      this.syncMesh();
    } else if (o.running && !before.running) {
      this.scheduleBringUp();
    }

    this.kick();
  }

  private reloadPlates(): void {
    const front = this.frontImg;
    const back = this.backImg;
    if (front) front.src = typeof this.o.front === "string" ? this.o.front : this.o.front.src;
    if (back) back.src = typeof this.o.back === "string" ? this.o.back : this.o.back.src;
    if (this.glLive) void this.loadTextures();
  }

  /** Paint at a point in 0..1 uv of the plate. Calls less than 200ms apart join
   *  into one continuous stroke. */
  paint(x: number, y: number, strength = 1): void {
    if (this.destroyed) return;
    this.apiPath.push(x, y);
    this.apiAmp = Math.max(0, Math.min(1, strength));
    if (this.apiPath.length > 512) {
      this.apiPath.splice(0, this.apiPath.length - 512);
    }
    this.kick();
  }

  /** Wipe the mask back to fully covered. Unconditional: with `brush.persist`
   *  on, nothing heals, so this is the only way back. */
  clear(): void {
    this.fillMask(0);
  }

  /** Flood the mask — `back` fully visible. Fades back out over `brush.trail`
   *  like any other stroke, unless `brush.persist` is on, where it stays. */
  revealAll(): void {
    this.fillMask(1);
  }

  private fillMask(value: number): void {
    if (this.destroyed) return;
    this.path.length = 0;
    this.apiPath.length = 0;
    this.pen.has = false;
    this.apiPen.has = false;
    if (this.gl && this.mask) {
      fillMaskPair(this.gl, this.mask, value);
    } else {
      this.pendingFill = value;
    }
    this.rawFraction = value;
    this.smoothFraction = value;
    /* the fraction is KNOWN the moment the mask is flooded — it does not have to
       be measured back off the GPU. Publishing it here rather than waiting for
       the next reduction is what makes `progress` agree with the mask even when
       no frame runs between the call and the read: a paused field, a field that
       is off-screen, or a hidden tab. */
    const f = Math.max(value, this.o.progress);
    if (f !== this.lastFraction) {
      this.lastFraction = f;
      const cb = this.o.onReveal;
      if (cb) defer(() => !this.destroyed && cb(f));
    }
    this.kick();
  }

  play(): void {
    if (this.destroyed || this.o.running) return;
    this.raw.running = true;
    this.o.running = true;
    if (!this.glLive) this.scheduleBringUp();
    this.kick();
  }

  pause(): void {
    if (this.destroyed) return;
    this.raw.running = false;
    this.o.running = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  /** Free the context, the observers, the listeners and the injected DOM. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unschedule?.();
    this.unschedule = null;
    this.teardownGL();
    this.unbindPointer();

    this.ro?.disconnect();
    this.io?.disconnect();
    this.ro = null;
    this.io = null;
    if (this.motionMq) removeMqListener(this.motionMq, this.onMotionChange);
    for (const mq of this.smallMqs) removeMqListener(mq, this.onSmallChange);
    this.smallMqs = [];
    this.motionMq = null;
    this.hoverMq = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("blur", this.onBlur);

    this.frontImg?.removeEventListener("load", this.onFrontLoad);
    this.canvas?.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas?.removeEventListener(
      "webglcontextrestored",
      this.onContextRestored
    );
    for (const node of this.injected) {
      if (node.parentNode === this.host) this.host.removeChild(node);
    }
    this.injected = [];
    this.canvas = null;
    this.frontImg = null;
    this.backImg = null;
    /* drop the claim, not the handle: destroying it is the caller's call */
    this.meshHandle = null;

    this.host.style.position = this.hostStyleBefore.position;
    if (this.ownsAspect) {
      this.host.style.aspectRatio = this.hostStyleBefore.aspectRatio;
    }
    this.host.classList?.remove("revealed--gl");
    this.strokes.reset();
  }

  /** Drop everything GL and fall back to the static plates. Reversible: a
   *  context restore or a reduced-motion change can bring it back. */
  private teardownGL(): void {
    const gl = this.gl;
    this.glLive = false;
    this.ready = false;
    /* the handle's GL objects go with the context either way — it watches the
       canvas for the loss itself, and its next `create()` allocates fresh ones.
       It is NOT destroyed here: the caller made it and the caller frees it, and
       a context restore has to find the parsed mesh still in memory. */
    this.meshLive = false;
    this.meshTuning = "";
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.setGlVisible(false);
    this.strokes.reset();
    if (!gl) {
      this.gl = null;
      return;
    }
    this.tearingDown = true;
    if (this.quad) gl.deleteBuffer(this.quad);
    if (this.progDisplay) gl.deleteProgram(this.progDisplay);
    if (this.progMask) gl.deleteProgram(this.progMask);
    if (this.progReduce) gl.deleteProgram(this.progReduce);
    if (this.texFront) gl.deleteTexture(this.texFront);
    if (this.texBack) gl.deleteTexture(this.texBack);
    if (this.texSkel) gl.deleteTexture(this.texSkel);
    if (this.reduceTarget) {
      gl.deleteTexture(this.reduceTarget.tex);
      gl.deleteFramebuffer(this.reduceTarget.fbo);
    }
    freeMaskPair(gl, this.mask);
    if (!gl.isContextLost()) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.quad = null;
    this.progDisplay = null;
    this.progMask = null;
    this.progReduce = null;
    this.uD = null;
    this.uM = null;
    this.uRRect = null;
    this.uRThreshold = null;
    this.texFront = null;
    this.texBack = null;
    this.texSkel = null;
    this.reduceTarget = null;
    this.mask = null;
    this.cur = 0;
    this.canvasW = 0;
    this.canvasH = 0;
    this.variantKey = "";
    this.gl = null;
    this.tearingDown = false;
  }
}

function defer(fn: () => void): void {
  if (typeof queueMicrotask === "function") queueMicrotask(fn);
  else void Promise.resolve().then(fn);
}

/** whether GL is going to be attempted at all in this environment */
function glPossible(): boolean {
  return !prefersReducedMotion() && hardwareGL();
}

/* Safari before 14 only has the deprecated addListener form, and it is still
   the only way to observe a media query there. */
function addMqListener(mq: MediaQueryList, fn: () => void): void {
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", fn);
  else mq.addListener(fn);
}

function removeMqListener(mq: MediaQueryList, fn: () => void): void {
  if (typeof mq.removeEventListener === "function") {
    mq.removeEventListener("change", fn);
  } else mq.removeListener(fn);
}
