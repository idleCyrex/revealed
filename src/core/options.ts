import { MASK_MIN } from "./mask.js";
import type {
  BrushOptions,
  EdgeOptions,
  EdgePreset,
  IdleOptions,
  ImageSource,
  RevealOptions,
  SkeletonOptions,
  UvRect,
  WaveOptions,
} from "./types.js";
import type { MeshSkeletonHandle } from "../mesh/types.js";

/* ------------------------------------------------------------------ *
 * defaults + presets
 * ------------------------------------------------------------------ */

/* carve and refraction both come down from what they were before the wave: the
   mask now supplies most of the character, so leaving the carve high would
   double-count it, and a strong rim fringe fights a faceted, torn boundary.
   `edge: "plain"` puts both back and turns the wave off. */
export const DEFAULT_EDGE: Required<EdgeOptions> = {
  scale: 7.5,
  carve: 0.38,
  detail: 0.28,
  feather: 0.012,
  threshold: 0.18,
  refraction: 0.008,
  refractionFalloff: 55,
  speed: 1,
  bubble: 0.5,
  bubbleScale: 2.5,
  facet: 0,
};

/** The resolved wave defaults. `enabled` is derived, never set by hand: it is
 *  true exactly while something is still moving the field. */
export const DEFAULT_WAVE: ResolvedWave = {
  enabled: true,
  advect: 2,
  inject: 1,
  swirl: 0.45,
  damping: 0.16,
  spread: 0.12,
  resolution: 512,
};

/** The resolved brush defaults. `healRate` is always a number here - it is the
 *  resolved form of `trail`, and `persist` is exactly `healRate === 0`. */
export const DEFAULT_BRUSH: ResolvedBrush = {
  radius: 0.3,
  persist: false,
  spotlight: false,
  trail: 2.8,
  healRate: 1 / 2.8,
  holdTimeout: 130,
  wave: DEFAULT_WAVE,
};

const DEFAULT_IDLE: Required<IdleOptions> = {
  enabled: true,
  strokes: 2,
  speed: 1,
  region: { x0: 0, y0: 0, x1: 1, y1: 1 },
  yieldAfter: 900,
};

const DEFAULT_SKELETON = {
  color: "#18375d",
  opacity: 0.18,
  mode: "draw" as const,
  period: 5.4,
  source: "alpha" as const,
  reactive: true,
};

/** Edge looks, as plain `EdgeOptions` patches over the defaults. */
export const presets: Record<EdgePreset, EdgeOptions> = {
  liquid: {},
  /* everything the library did before the wave, in one word: the old carve and
     refraction back, no bubbles, and (via PRESET_WAVE below) no momentum */
  plain: { carve: 0.62, refraction: 0.012, bubble: 0, facet: 0 },
  dissolve: {
    scale: 22,
    carve: 0.5,
    detail: 0.4,
    feather: 0.008,
    bubble: 0.8,
    bubbleScale: 4,
  },
  ink: { scale: 4, carve: 0.8, detail: 0.15, speed: 0.4, refraction: 0.02 },
  shatter: {
    scale: 12,
    carve: 1.1,
    detail: 0.05,
    feather: 0.004,
    refraction: 0,
    bubble: 0.3,
    facet: 1,
  },
  clean: {
    carve: 0,
    detail: 0,
    feather: 0.02,
    refraction: 0,
    bubble: 0,
    facet: 0,
  },
};

/** The wave a NAMED edge preset implies. It lives here rather than in `presets`
 *  because the wave is a brush option, not an edge one, and `presets` is public
 *  and documented as an `EdgeOptions` patch you can spread. An explicit
 *  `brush.wave` always wins over this; `edge` given as an object never picks up
 *  a preset wave at all, because there is no preset to pick it up from. */
const PRESET_WAVE: Partial<Record<EdgePreset, boolean | WaveOptions>> = {
  /* the two "give me none of this" presets. `plain` is the documented way back
     to the pre-wave library, and `clean`'s whole contract is no character */
  plain: false,
  clean: false,
  /* slower and more curling: a blot wants to roll, not to be thrown */
  ink: { swirl: 0.7, damping: 0.35 },
};

/* ------------------------------------------------------------------ *
 * resolved shapes - every optional filled in, colours pre-parsed
 * ------------------------------------------------------------------ */

export type ResolvedEdge = Required<EdgeOptions>;

export interface ResolvedWave {
  /** true iff something still moves the field - the resolved twin of
   *  `advect > 0 || inject > 0`, the same way `persist` is of `healRate === 0` */
  enabled: boolean;
  advect: number;
  inject: number;
  swirl: number;
  damping: number;
  /** already forced to 0 under `persist` and clamped under `healRate` */
  spread: number;
  resolution: number;
}

export interface ResolvedBrush {
  radius: number;
  /** true iff nothing ever heals - the resolved twin of `healRate === 0` */
  persist: boolean;
  /** true iff everything heals every frame - the resolved twin of
   *  `healRate === Infinity`, and the other end of the same number */
  spotlight: boolean;
  trail: number;
  /** mask units healed per second. 0 = permanent, Infinity = no trail at all */
  healRate: number;
  holdTimeout: number;
  wave: ResolvedWave;
}

export interface ResolvedSkeleton {
  /** null exactly when the skeleton is a mesh: there is no image to load */
  src: ImageSource | null;
  /** the caller's mesh handle, or null for an image skeleton. Never created
   *  or destroyed here - the field only drives and binds it. */
  mesh: MeshSkeletonHandle | null;
  /** 0..1 sRGB triple, ready for a vec3 uniform */
  color: [number, number, number];
  opacity: number;
  mode: "draw" | "hold" | "pulse" | "scan";
  period: number;
  source: "alpha" | "luma" | "image";
  reactive: boolean;
}

export interface ResolvedIdle {
  enabled: boolean;
  strokes: number;
  speed: number;
  region: UvRect;
  /** seconds, not ms: everything downstream of here runs on a seconds clock */
  yieldAfter: number;
}

export interface ResolvedOptions {
  front: ImageSource;
  back: ImageSource;
  skeleton: ResolvedSkeleton | null;
  aspect: number | null;
  edge: ResolvedEdge;
  brush: ResolvedBrush;
  idle: ResolvedIdle;
  maxDpr: number;
  running: boolean;
  progress: number;
  measure: UvRect;
  onReveal: ((fraction: number) => void) | undefined;
  onReady: (() => void) | undefined;
  onError: ((err: Error) => void) | undefined;
  pointerTarget: HTMLElement | null;
  deferInit: boolean;
}

const num = (v: unknown, fallback: number) =>
  typeof v === "number" && isFinite(v) ? v : fallback;

/* Development-only complaint about a self-contradictory option pair. Once per
   message per page, because it fires from normalizeOptions and setOptions can
   run every frame. Silent under an explicit production build; there is no
   `process` in the CDN bundle, and a genuine misconfiguration is worth one line
   there too. */
const warned = new Set<string>();
function warnDev(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  let dev = true;
  try {
    dev =
      (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
        ?.NODE_ENV !== "production";
  } catch {
    /* no process at all: treat as development */
  }
  if (dev && typeof console !== "undefined") console.warn(`revealed: ${msg}`);
}

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

function rect(v: UvRect | undefined, fallback: UvRect): UvRect {
  if (!v) return fallback;
  return {
    x0: clamp(num(v.x0, fallback.x0), 0, 1),
    y0: clamp(num(v.y0, fallback.y0), 0, 1),
    x1: clamp(num(v.x1, fallback.x1), 0, 1),
    y1: clamp(num(v.y1, fallback.y1), 0, 1),
  };
}

const WHOLE: UvRect = { x0: 0, y0: 0, x1: 1, y1: 1 };

/* ------------------------------------------------------------------ *
 * colour
 * ------------------------------------------------------------------ */

const HEX = /^#([0-9a-f]{3,8})$/i;
const FUNC = /^rgba?\(([^)]+)\)$/i;

/** CSS colour -> 0..1 sRGB triple. Hex and rgb()/rgba() are parsed outright;
 *  anything else (named colours, hsl, color-mix) is handed to a throwaway 2d
 *  context, which is the only zero-dependency way to resolve them. */
export function parseColor(css: string): [number, number, number] {
  const s = String(css).trim();

  const hex = HEX.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    const n = parseInt(h.slice(0, 6), 16);
    return [
      ((n >> 16) & 255) / 255,
      ((n >> 8) & 255) / 255,
      (n & 255) / 255,
    ];
  }

  const fn = FUNC.exec(s);
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean);
    const ch = (i: number) => {
      const p = parts[i] ?? "0";
      const v = parseFloat(p);
      return clamp((p.indexOf("%") >= 0 ? (v / 100) * 255 : v) / 255, 0, 1);
    };
    return [ch(0), ch(1), ch(2)];
  }

  if (typeof document !== "undefined") {
    try {
      const cv = document.createElement("canvas");
      cv.width = 1;
      cv.height = 1;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.fillStyle = "#000";
        ctx.fillStyle = s;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0] / 255, d[1] / 255, d[2] / 255];
      }
    } catch {
      /* tainted or headless: fall through to the default below */
    }
  }
  return [0.094, 0.216, 0.365];
}

/* ------------------------------------------------------------------ *
 * images
 * ------------------------------------------------------------------ */

/** The url this source resolves to right now. `small` wins while the viewport
 *  is at or under `smallMaxWidth`, which is also what the injected <picture>
 *  source uses, so the plate and the texture are never two different files. */
export function resolveImage(src: ImageSource, viewportWidth?: number): string {
  if (typeof src === "string") return src;
  if (!src.small) return src.src;
  const max = num(src.smallMaxWidth, 640);
  const w =
    viewportWidth ??
    (typeof window !== "undefined" ? window.innerWidth : Infinity);
  return w <= max ? src.small : src.src;
}

export function smallMaxWidth(src: ImageSource): number | null {
  if (typeof src === "string" || !src.small) return null;
  return num(src.smallMaxWidth, 640);
}

export function smallSrc(src: ImageSource): string | null {
  return typeof src === "string" ? null : src.small ?? null;
}

/** Stable identity for a source, so `setOptions` can tell "same image, new
 *  object literal" from "actually a different image". */
export function imageKey(src: ImageSource | null | undefined): string {
  if (!src) return "";
  if (typeof src === "string") return src;
  return `${src.src}|${src.small ?? ""}|${src.smallMaxWidth ?? 640}`;
}

/* ------------------------------------------------------------------ *
 * normalize
 * ------------------------------------------------------------------ */

function normalizeEdge(edge: RevealOptions["edge"]): ResolvedEdge {
  const patch: EdgeOptions =
    typeof edge === "string" ? presets[edge] ?? {} : edge ?? {};
  return {
    scale: Math.max(0.01, num(patch.scale, DEFAULT_EDGE.scale)),
    carve: Math.max(0, num(patch.carve, DEFAULT_EDGE.carve)),
    detail: Math.max(0, num(patch.detail, DEFAULT_EDGE.detail)),
    /* the cut is smoothstep(-feather, feather, field): a zero width would make
       both edges equal and the result undefined, so it has a floor */
    feather: Math.max(0.0005, num(patch.feather, DEFAULT_EDGE.feather)),
    threshold: clamp(num(patch.threshold, DEFAULT_EDGE.threshold), 0.01, 0.99),
    refraction: Math.max(0, num(patch.refraction, DEFAULT_EDGE.refraction)),
    refractionFalloff: Math.max(
      0.01,
      num(patch.refractionFalloff, DEFAULT_EDGE.refractionFalloff)
    ),
    speed: num(patch.speed, DEFAULT_EDGE.speed),
    bubble: Math.max(0, num(patch.bubble, DEFAULT_EDGE.bubble)),
    /* under 1 the "bands" are not bands at all and the term degenerates into a
       second carve; the floor keeps the option meaning what it says */
    bubbleScale: Math.max(1, num(patch.bubbleScale, DEFAULT_EDGE.bubbleScale)),
    facet: clamp(num(patch.facet, DEFAULT_EDGE.facet), 0, 1),
  };
}

function normalizeSkeleton(
  sk: RevealOptions["skeleton"]
): ResolvedSkeleton | null {
  if (!sk) return null;
  /* `{ src }` is ambiguous - it is a valid ImageSource AND a valid
     SkeletonOptions - but the two agree on what it means, so only the
     ImageSource-only keys have to discriminate */
  let o: SkeletonOptions;
  if (typeof sk === "string") o = { src: sk };
  else if ("small" in sk || "smallMaxWidth" in sk) o = { src: sk as ImageSource };
  else o = sk as SkeletonOptions;

  const common = {
    color: parseColor(o.color ?? DEFAULT_SKELETON.color),
    opacity: clamp(num(o.opacity, DEFAULT_SKELETON.opacity), 0, 1),
    mode: o.mode ?? DEFAULT_SKELETON.mode,
    period: Math.max(0.1, num(o.period, DEFAULT_SKELETON.period)),
    reactive: o.reactive ?? DEFAULT_SKELETON.reactive,
  };

  /* the mesh branch comes first: a handle and an image are two answers to the
     same question, and the handle is the more specific one. `source` is not a
     choice here - the mesh writes premultiplied black plus alpha, which is
     exactly what the display pass's "alpha" branch reads and tints. */
  if (o.mesh) {
    if (o.src) {
      warnDev(
        "skeleton.src and skeleton.mesh are two skeletons; mesh wins, drop one."
      );
    }
    if (o.source && o.source !== "alpha") {
      warnDev(
        `skeleton.source: "${o.source}" does not apply to a mesh skeleton ` +
          "(it writes alpha); forcing \"alpha\"."
      );
    }
    return { src: null, mesh: o.mesh, source: "alpha", ...common };
  }

  if (!o.src) return null;
  /* "scan" is a mesh-only animation - it lives in the model's object space and
     there is no object space in a texture. Collapsed to its nearest image
     equivalent rather than rejected, so a shared config can carry it. */
  if (common.mode === "scan") common.mode = "hold";
  return {
    src: o.src,
    mesh: null,
    source: o.source ?? DEFAULT_SKELETON.source,
    ...common,
  };
}

/** `enabled` is derived, not read: `false` (either spelling) zeroes the two
 *  terms that move the field, and anything that leaves one of them positive is
 *  enabled. The same collapse `persist` gets from `healRate === 0`.
 *
 *  `spread` is the one genuinely dangerous number in here - it is the only term
 *  that ADDS to the reveal field - so it is resolved against the heal rate and
 *  not against its own bounds: with `persist` (`healRate === 0`) nothing ever
 *  takes value back out, so a creep of any size would eventually reach every
 *  texel on the plate. It is forced to 0 there, and clamped under the heal rate
 *  otherwise. (The pass bounds it a second time, per texel travelled, so this
 *  is the outer of two independent guarantees, not the only one.) */
function normalizeWave(
  w: boolean | WaveOptions | undefined,
  healRate: number
): ResolvedWave {
  const o: WaveOptions = w && typeof w === "object" ? w : {};
  /* `spotlight` (healRate Infinity) turns the wave off outright rather than
     just muting `spread`: momentum that outlives the frame IS a trail, which is
     the one thing that mode is defined by not having. Forced, not defaulted -
     an explicit `wave` cannot bring it back, because it could not work. */
  const off = w === false || o.enabled === false || !isFinite(healRate);
  const advect = off ? 0 : Math.max(0, num(o.advect, DEFAULT_WAVE.advect));
  const inject = off ? 0 : Math.max(0, num(o.inject, DEFAULT_WAVE.inject));
  const enabled = advect > 0 || inject > 0;
  let spread = off ? 0 : Math.max(0, num(o.spread, DEFAULT_WAVE.spread));
  spread = healRate === 0 ? 0 : Math.min(spread, healRate);
  return {
    enabled,
    advect,
    inject,
    swirl: clamp(num(o.swirl, DEFAULT_WAVE.swirl), 0, 1),
    /* survival per second. 1 would be a field that never settles, and the wave
       has to end, so the top of the range is 0.98 */
    damping: clamp(num(o.damping, DEFAULT_WAVE.damping), 0, 0.98),
    spread,
    resolution: Math.max(
      MASK_MIN,
      Math.round(num(o.resolution, DEFAULT_WAVE.resolution))
    ),
  };
}

/** `trail` is a duration, `healRate` is its reciprocal, and `persist` and
 *  `spotlight` are the two named ends of that one number: 0 (nothing ever
 *  heals) and Infinity (everything heals every frame, so the reveal is only
 *  where the pointer is now). The rate is what the loop actually uses, so all
 *  four are resolved down to it here and nothing downstream has to branch -
 *  `spotlight` needs no special case anywhere, because a decay of a whole mask
 *  unit per frame already falls out of the existing decay path. */
function normalizeBrush(
  b: BrushOptions | undefined,
  presetWave: boolean | WaveOptions | undefined
): ResolvedBrush {
  const trail = Math.max(0.05, num(b?.trail, DEFAULT_BRUSH.trail));
  /* Precedence, coarsest knob first: `persist` beats `spotlight` beats an
     explicit `healRate` beats `trail`. persist + spotlight is not a blend of
     anything - they are opposite ends - so one has to win outright, and it is
     the one that was there first and that the rest of the library already
     branches on. */
  let healRate: number;
  if (b?.persist === true) {
    if (b?.spotlight === true) {
      warnDev(
        "brush.persist and brush.spotlight are opposites (healRate 0 and " +
          "Infinity). persist wins; drop one."
      );
    }
    healRate = 0;
  } else if (b?.spotlight === true) {
    healRate = Infinity;
  } else {
    /* an explicit `healRate: Infinity` is the same request spelled the long
       way, and `num` would otherwise reject it as non-finite */
    healRate =
      b?.healRate === Infinity
        ? Infinity
        : Math.max(0, num(b?.healRate, 1 / trail));
  }
  return {
    radius: Math.max(0.001, num(b?.radius, DEFAULT_BRUSH.radius)),
    persist: healRate === 0,
    spotlight: healRate === Infinity,
    trail,
    healRate,
    holdTimeout: Math.max(0, num(b?.holdTimeout, DEFAULT_BRUSH.holdTimeout)),
    wave: normalizeWave(b?.wave !== undefined ? b.wave : presetWave, healRate),
  };
}

/** `defaultEnabled` is false when the reveal is permanent: an autopilot that
 *  never heals would uncover the whole image on its own, which is a legitimate
 *  look but a terrible default. An explicit `idle` from the caller still wins. */
function normalizeIdle(
  idle: RevealOptions["idle"],
  defaultEnabled: boolean
): ResolvedIdle {
  if (idle === false) return { ...DEFAULT_IDLE, enabled: false, yieldAfter: 0.9 };
  const o: IdleOptions = idle === true || !idle ? {} : idle;
  return {
    enabled: idle === true ? true : o.enabled ?? defaultEnabled,
    strokes: Math.round(clamp(num(o.strokes, DEFAULT_IDLE.strokes), 1, 4)),
    speed: Math.max(0.05, num(o.speed, DEFAULT_IDLE.speed)),
    region: rect(o.region, DEFAULT_IDLE.region),
    yieldAfter: Math.max(0, num(o.yieldAfter, DEFAULT_IDLE.yieldAfter)) / 1000,
  };
}

export function normalizeOptions(o: RevealOptions): ResolvedOptions {
  const aspect = typeof o.aspect === "number" && o.aspect > 0 ? o.aspect : null;
  const brush = normalizeBrush(
    o.brush,
    typeof o.edge === "string" ? PRESET_WAVE[o.edge] : undefined
  );
  return {
    front: o.front,
    back: o.back,
    skeleton: normalizeSkeleton(o.skeleton),
    aspect,
    edge: normalizeEdge(o.edge),
    brush,
    idle: normalizeIdle(o.idle, !brush.persist),
    maxDpr: Math.max(0.5, num(o.maxDpr, 1.5)),
    running: o.running ?? true,
    progress: clamp(num(o.progress, 0), 0, 1),
    measure: rect(o.measure, WHOLE),
    onReveal: o.onReveal,
    onReady: o.onReady,
    onError: o.onError,
    pointerTarget: o.pointerTarget ?? null,
    deferInit: o.deferInit ?? true,
  };
}
