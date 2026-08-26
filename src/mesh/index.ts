/* `revealed/mesh` — the 3D wireframe skeleton.
 *
 * A subpath entry, not part of the core bundle: a couple of KB gzipped is the
 * wrong tax to put on every consumer for a feature that needs a 3D model most
 * of them do not have. The core stays byte-identical without it.
 *
 *   import { meshSkeleton } from "revealed/mesh";
 *
 *   const mesh = meshSkeleton({ mesh: "/helmet.json", meshParallax: 5 });
 *   mesh.create(gl);
 *   mesh.resize(plateW, plateH);
 *   // per frame, before the display pass:
 *   mesh.update(dt, { x: pointerUv.x * 2 - 1, y: pointerUv.y * 2 - 1 });
 *   mesh.render();
 *   gl.activeTexture(gl.TEXTURE4);
 *   gl.bindTexture(gl.TEXTURE_2D, mesh.texture);   // the uSkel slot
 *
 * The mesh renders into the texture the display pass already samples as
 * `uSkel`, so the display shader is untouched: the skeleton is still stamped
 * onto the front plate before the reveal mix (so it is wiped exactly where the
 * back plate is uncovered), and `mode: "draw" | "hold" | "pulse"`, `reactive`,
 * `color` and `opacity` all keep working on the sampled texture.
 */

import { loadMesh } from "./parse.js";
import { MeshWireframe } from "./renderer.js";
import type { MeshSkeletonHandle, MeshSkeletonOptions } from "./types.js";

/** Create a mesh skeleton. The fetch starts immediately and is never awaited:
 *  nothing downstream — not `create`, not `render`, not the host's `onReady` —
 *  blocks on it, and a mesh that 404s, fails to parse, or exceeds the index
 *  limit reports through `onError` and leaves a transparent skeleton texture.
 *  The reveal must never be held up by a decorative asset. */
export function meshSkeleton(opts: MeshSkeletonOptions): MeshSkeletonHandle {
  const w = new MeshWireframe(opts);
  let token = 0;
  let current = opts.mesh;

  const fetchMesh = (src: MeshSkeletonOptions["mesh"]): void => {
    const mine = ++token;
    loadMesh(src).then(
      (data) => {
        if (mine === token) w.setMesh(data);
      },
      (err: unknown) => {
        if (mine !== token) return;
        w.setMesh(null);
        opts.onError?.(
          err instanceof Error ? err : new Error(String(err ?? "mesh failed"))
        );
      }
    );
  };
  fetchMesh(opts.mesh);

  const setOptions = w.setOptions.bind(w);
  w.setOptions = (patch: Partial<MeshSkeletonOptions>): void => {
    setOptions(patch);
    if (patch.mesh !== undefined && patch.mesh !== current) {
      current = patch.mesh;
      fetchMesh(patch.mesh);
    }
  };
  const destroy = w.destroy.bind(w);
  w.destroy = (): void => {
    token++; // an in-flight fetch can no longer touch a destroyed renderer
    destroy();
  };
  return w;
}

export { MeshWireframe } from "./renderer.js";
export { loadMesh, parseObj, parseEdgeJson, fromArrays, MAX_VERTICES } from "./parse.js";
export type {
  MeshData,
  MeshPointer,
  MeshSkeletonHandle,
  MeshSkeletonOptions,
  MeshSource,
} from "./types.js";
