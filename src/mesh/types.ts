/* Public types for the mesh skeleton. Deliberately self-contained: this module
   never imports from ../core, so the two can be rewritten independently and the
   subpath entry stays a leaf. The only shared contract is a WebGL1 context and
   the `uSkel` texture slot. */

/** A mesh, either as a url to fetch (`.obj` or `.json`, sniffed by extension
 *  and then by content) or as arrays the caller already has in memory.
 *
 *  - positions: xyz triples in model space. Normalised to a unit box on load,
 *    so any scale works; pre-normalised data is unchanged by that pass.
 *  - edges: vertex-index pairs. Uint16 only — 65,535 vertices is far above the
 *    visual budget for a wireframe, so `OES_element_index_uint` is never needed.
 */
export type MeshSource =
  | string
  | {
      positions: Float32Array | number[];
      edges: Uint16Array | Uint32Array | number[];
    };

/** A parsed, deduplicated, unit-box-normalised mesh. */
export interface MeshData {
  positions: Float32Array;
  /** vertex-index pairs; `edges.length / 2` is the edge count */
  edges: Uint16Array;
}

/** Options the mesh pass owns. Every key here is additive to `SkeletonOptions`;
 *  `color`, `opacity`, `source` and `reactive` stay in the display pass and are
 *  not read here. `mode` and `period` are read only for `"scan"` (§7.5). */
export interface MeshSkeletonOptions {
  /** the mesh. mutually exclusive with `SkeletonOptions.src`; mesh wins. */
  mesh: MeshSource;
  /** peak yaw in degrees at |pointer.x| = 1. default 5 (the reference is ~4.3) */
  meshParallax?: number;
  /** 0..1 approach per 60 Hz frame, frame-rate corrected. default 0.03 */
  meshDamping?: number;
  /** constant pitch offset in degrees. suppressed below 768 px, as the
   *  reference does. default 10 */
  meshTilt?: number;
  /** fraction of the plate HEIGHT the model's largest dimension fills.
   *  default 1 */
  meshScale?: number;
  /** translation in plate uv, y-down, applied after projection. default [0,0] */
  meshOffset?: [number, number];
  /** line width in device pixels of the skeleton target. 1 (default) uses
   *  `gl.LINES`; > 1 builds an expanded-quad buffer at load time (4x vertices,
   *  1.5x indices, one extra attribute buffer). */
  thickness?: number;
  /** only `"scan"` is handled here — an object-space Y travelling band, which
   *  is the one thing a texture cannot do. the other three are opacity
   *  envelopes in the display pass and need nothing from the mesh. */
  mode?: "draw" | "hold" | "pulse" | "scan";
  /** seconds for one scan cycle. default 5.4, matching the skeleton default. */
  period?: number;
  /** cap on the skeleton target's long edge. the ghost is upsampled with
   *  bilinear, which helps the hairlines read soft rather than aliased.
   *  default 512 */
  meshResolution?: number;
  /** alpha written per line fragment, before the display pass scales the whole
   *  stamp by `opacity`. Overlapping edges accumulate, which is the reference's
   *  look. default 0.55 */
  meshAlpha?: number;
  /** attach a depth renderbuffer to the skeleton's OWN framebuffer, so back
   *  edges are hidden. The host context's `depth` attribute is irrelevant
   *  either way. The reference is not depth-tested and neither are we by
   *  default. default false */
  meshDepth?: boolean;
  /** override the `prefers-reduced-motion` media query. null/undefined = auto */
  reducedMotion?: boolean | null;
  /** informational, never fatal: a 404, a parse failure, or a mesh over the
   *  index limit. The skeleton target stays allocated and transparent, so the
   *  reveal is completely unaffected. */
  onError?: (err: Error) => void;
}

/** Pointer position in normalised plate space: -1..1 on each axis, y DOWN
 *  (+1 is the bottom of the plate), matching the uv convention the display
 *  pass already uses. `uv * 2 - 1`. */
export interface MeshPointer {
  x: number;
  y: number;
}

/** The lifecycle the host drives. Every method is safe to call in any order and
 *  at any time, including before `create`, after `destroy`, and while the
 *  context is lost. */
export interface MeshSkeletonHandle {
  /** bind this to the `uSkel` texture unit. Non-null from a successful
   *  `create()` onward, and transparent until a mesh has loaded — so a mesh
   *  that never arrives is invisible rather than a black stamp. */
  readonly texture: WebGLTexture | null;
  /** true once a mesh is parsed and uploaded. */
  readonly ready: boolean;
  /** edge count of the loaded mesh, 0 if none. */
  readonly edgeCount: number;
  /** true if `render()` would change the target. */
  readonly dirty: boolean;
  /** allocate GL objects on this context. Idempotent: tears down anything it
   *  previously held first, so it doubles as the context-restore path. Returns
   *  false only if not even a 1x1 fallback texture could be made. */
  create(gl: WebGLRenderingContext): boolean;
  /** plate size in any consistent unit; only the ratio and the cap matter. */
  resize(width: number, height: number): void;
  /** advance the damped pose. `dt` in seconds, `pointer` null while the pointer
   *  is away (the pose eases back to neutral). */
  update(dt: number, pointer: MeshPointer | null): void;
  /** draw the wireframe into the skeleton target. Saves and restores every
   *  piece of GL state it touches, so the host needs no rebinding. */
  render(): void;
  /** merge new options. Everything is live except `mesh`, which refetches, and
   *  `thickness` crossing 1, which rebuilds the buffers. */
  setOptions(patch: Partial<MeshSkeletonOptions>): void;
  /** release every buffer, texture, framebuffer, renderbuffer and program, and
   *  drop the media-query listener. The parsed mesh is kept, so a later
   *  `create()` is an upload rather than a refetch. */
  destroy(): void;
}
