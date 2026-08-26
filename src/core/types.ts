import type { MeshSkeletonHandle } from "../mesh/types.js";

/** A src, or a src plus a narrow-viewport swap. */
export type ImageSource =
  | string
  | { src: string; small?: string; smallMaxWidth?: number /* default 640 */ };

export type EdgePreset =
  | "liquid"
  | "plain"
  | "dissolve"
  | "ink"
  | "shatter"
  | "clean";

export interface EdgeOptions {
  /** fbm frequency of the carve. higher = finer lace. default 7.5 */
  scale?: number;
  /** how hard the noise chews the boundary, 0..1.5. 0 = smooth blob. default
   *  0.38 — it was 0.62 before the wave, and `edge: "plain"` restores that */
  carve?: number;
  /** secondary, finer octave amount. default 0.28 */
  detail?: number;
  /** anti-alias width of the cut in field units. 0.012 = knife edge. default 0.012 */
  feather?: number;
  /** mask value the cut happens at. clamped to 0.01..0.99. default 0.18 */
  threshold?: number;
  /** rim refraction strength in uv. 0 disables. default 0.008 — it was 0.012
   *  before the wave, and `edge: "plain"` restores that */
  refraction?: number;
  /** how tightly refraction hugs the rim. default 55 */
  refractionFalloff?: number;
  /** drift speed of the noise field. default 1 */
  speed?: number;
  /** how hard the banded-noise term punches holes THROUGH the reveal, leaving
   *  islands of `front` standing inside uncovered ground and detached specks
   *  outside it. 0 = the plain carve and nothing else. useful range 0..1.2.
   *  default 0.5 */
  bubble?: number;
  /** how many nested level sets one noise hill is wrapped into: higher = more,
   *  smaller holes. much over 4 it degenerates into visible contour rings.
   *  default 2.5 */
  bubbleScale?: number;
  /** 0 = the mask is read bilinear and the tear is smooth; 1 = it is read on
   *  its own grid, giving a low-poly, faceted tear. blends in between.
   *  default 0 */
  facet?: number;
}

/** Momentum. The mask carries a velocity field in its two spare channels: a
 *  stroke injects into it, and the reveal is then transported by it — so the
 *  wave keeps travelling, and keeps tearing itself into islands, for about a
 *  second after the pointer stops. */
export interface WaveOptions {
  /** master switch. `false` is exactly the pre-wave behaviour. default true */
  enabled?: boolean;
  /** how far the field is carried along its own velocity each second, in uv at
   *  full speed. 0 = no momentum. default 2 */
  advect?: number;
  /** velocity injected per unit of brush strength, along the stroke. this is
   *  what makes a stroke *throw* the reveal forward. default 1 */
  inject?: number;
  /** 0 = injected velocity is purely along the stroke; 1 = purely perpendicular
   *  and counter-rotating on either side of it. the rotational part is what
   *  produces the vortex-core holes and the detached islands. default 0.45 */
  swirl?: number;
  /** fraction of the velocity field that survives one second, 0..0.98. lower =
   *  the wave stops sooner. default 0.16 */
  damping?: number;
  /** how fast the reveal creeps into its neighbours, in uv per second. bounded
   *  by construction — the creep loses a fixed slice of mask value per texel
   *  travelled, so it always runs out. forced to 0 under `persist`.
   *  default 0.12 */
  spread?: number;
  /** cap on the mask's long edge while the wave is on. lower = more faceted,
   *  and cheaper. default 512 */
  resolution?: number;
}

export interface BrushOptions {
  /** radius in aspect-corrected units (1 = image height). default 0.3 */
  radius?: number;
  /** Painted area never fades: once uncovered, `back` stays visible until
   *  `clear()` is called. `trail` is ignored while this is on. Default false. */
  persist?: boolean;
  /** No trail at all: the reveal is only where the pointer is this frame, and
   *  closes immediately behind it — a torch, not a paint stroke. Exactly
   *  `healRate: Infinity`, the far end of the same number `persist` is the near
   *  end of. `trail` is ignored while this is on, and so is `wave`: a
   *  propagating wave IS a trail. Contradicts `persist`, which wins.
   *  Default false. */
  spotlight?: boolean;
  /** With `persist` off, seconds a stroke stays before it has fully faded.
   *  default 2.8 */
  trail?: number;
  /** How the mask heals, in mask units per second. Derived from `trail` by
   *  default; `persist: true` is exactly `healRate: 0` and `spotlight: true` is
   *  exactly `healRate: Infinity`. Set it directly for a slow permanent-ish
   *  fade. Default undefined (derive from `trail`). */
  healRate?: number;
  /** ms of pointer stillness after which painting stops. default 130 */
  holdTimeout?: number;
  /** momentum: a stroke throws the reveal forward and it keeps travelling after
   *  the pointer stops. `false` is exactly `{ enabled: false }`. default true,
   *  or false when `edge` is the `"plain"` or `"clean"` preset, or when
   *  `spotlight` is on — where a travelling wave would be a trail. */
  wave?: boolean | WaveOptions;
}

export interface SkeletonOptions {
  /** the line art, as an image. One of `src` or `mesh` is required; giving
   *  both is a misconfiguration and `mesh` wins. */
  src?: ImageSource;
  /** a 3D wireframe skeleton instead of an image, from the `revealed/mesh`
   *  subpath:
   *
   *      import { meshSkeleton } from "revealed/mesh";
   *      const mesh = meshSkeleton({ mesh: "/helmet.json" });
   *      new RevealField(el, { front, back, skeleton: { mesh } });
   *
   *  The handle's lifecycle is the CALLER's: you create it, you `destroy()`
   *  it. The field only drives it — create / resize / update / render — and
   *  binds its texture where the image skeleton's would have gone, so `color`,
   *  `opacity`, `reactive`, `mode` and `period` all keep working on it.
   *  `source` is forced to `"alpha"`, which is what the mesh writes.
   *
   *  The mesh fetch is never awaited: a mesh that 404s leaves a transparent
   *  skeleton and the reveal runs exactly as if none had been asked for. */
  mesh?: MeshSkeletonHandle;
  /** any CSS colour the line art is tinted to. ignored by `source: "image"`,
   *  which draws the art untinted. default "#18375d" */
  color?: string;
  /** peak opacity. default 0.18 */
  opacity?: number;
  /** "draw" sketches a pen front top→bottom then fades; "hold" is constant;
   *  "pulse" breathes; "scan" is mesh-only — a travelling band in the model's
   *  OWN object space, so it sweeps the geometry rather than the screen (with
   *  an image skeleton it is identical to "hold"). default "draw".
   *
   *  With a mesh, `mode` and `period` are forwarded to the handle, so set them
   *  here rather than on `meshSkeleton()`. */
  mode?: "draw" | "hold" | "pulse" | "scan";
  /** seconds for one draw-on / hold / fade cycle. default 5.4 */
  period?: number;
  /** how the source image becomes coverage:
   *  "alpha" (default) uses its alpha, "luma" uses 1 - luminance (black lines on white),
   *  "image" draws the image as-is with no tint. */
  source?: "alpha" | "luma" | "image";
  /** ride the strokes: coverage rises to `opacity` while the pointer or an idle
   *  stroke is passing, and falls to about a ninth of it on a still, untouched
   *  field. false holds it at `opacity`. default true */
  reactive?: boolean;
}

export interface IdleOptions {
  /** autopilot strokes so the effect breathes with no pointer. default true, or
   *  false when `brush.persist` is on — an autopilot that never heals would
   *  uncover the whole image on its own. */
  enabled?: boolean;
  /** concurrent strokes, 1..4. default 2 */
  strokes?: number;
  /** stroke travel speed multiplier. default 1 */
  speed?: number;
  /** rect in 0..1 uv the strokes aim through. default whole image */
  region?: UvRect;
  /** ms of pointer inactivity before the autopilot starts spawning again. a
   *  stroke already in flight is never cut off. default 900 */
  yieldAfter?: number;
}

export interface RevealOptions {
  front: ImageSource;
  back: ImageSource;
  skeleton?: ImageSource | SkeletonOptions;
  /** width / height of the plates. If omitted it is read from the loaded front image. */
  aspect?: number;
  edge?: EdgePreset | EdgeOptions;
  brush?: BrushOptions;
  idle?: boolean | IdleOptions;
  /** cap on devicePixelRatio, floored at 0.5. default 1.5 */
  maxDpr?: number;
  /** false parks the render loop; the canvas keeps its last frame. default true */
  running?: boolean;
  /** 0..1 forced reveal floor, for scroll-driven or controlled use. default 0 */
  progress?: number;
  /** rect in uv the reveal fraction is measured over. default whole image */
  measure?: UvRect;
  /** called ~10x/s with `max(measured, progress)` of `measure` uncovered, and
   *  immediately after `clear()` / `revealAll()` even if no frame runs */
  onReveal?: (fraction: number) => void;
  /** called once the plates are decoded and the first frame has painted — or,
   *  where the effect is never going to run, once the front plate has decoded */
  onReady?: () => void;
  /** called when a degradation is taken and the static front plate is kept: no
   *  hardware WebGL, a failed context, shader link or allocation, or a plate
   *  that failed to load. Informational, never fatal. Reduced motion is not an
   *  error and does not fire it. */
  onError?: (err: Error) => void;
  /** element the pointer is tracked on. default the host element */
  pointerTarget?: HTMLElement | null;
  /** defer GL bring-up to requestIdleCallback. default true */
  deferInit?: boolean;
}

/** A rectangle in 0..1 uv of the plate, y down. */
export interface UvRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
