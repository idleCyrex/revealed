/* Mesh parsing: a JSON edge list (the native, production format) and a minimal
   OBJ subset (the authoring convenience).

   ── Author path ─────────────────────────────────────────────────────────────
   Getting from a real model to something this module can draw:

   1. Blender: File > Export > Wavefront (.obj). Turn ON "Triangulated Mesh",
      turn OFF normals, UVs, materials - none of them are read and they triple
      the file. Selection Only if the scene has more than the hero.
   2. Decimate first. Add a Decimate modifier and pull the ratio down until the
      face count lands in the budget below. A wireframe drawn at ~0.5 alpha with
      no depth test turns into grey mush long before it turns into a
      performance problem, so this is a VISUAL limit, not a cost one.
   3. Budget: 1,500-3,000 edges for a hero. Below 1,500 the shell reads as a
      cage rather than a surface; by 6,000 it is already closer to grey mush
      than to structure, whatever the alpha. The technical ceiling is much
      higher (8,000 edges is still one draw call and ~200 KB of buffers) --
      the limit that bites is visual, not budgetary.
   4. Run `node src/mesh/obj-to-edges.mjs model.obj model.json` to get the JSON
      edge list. Production sites should ship the JSON: it is smaller, it is
      already deduplicated and normalised, and it skips the OBJ parser
      entirely (the parser is still in the bundle either way - it is ~90 lines
      - but the CPU work at load is one JSON.parse).

   Positions are normalised into a centred unit box on load, so exporter scale
   and origin do not matter. Y up is assumed for `mode: "scan"`, which travels
   along object-space Y; anything else just scans along whatever axis is Y.
   ──────────────────────────────────────────────────────────────────────────── */

import type { MeshData, MeshSource } from "./types.js";

/** Uint16 indices cap the mesh here. Far above the visual budget, so this is a
 *  validation boundary rather than a limitation worth working around. */
export const MAX_VERTICES = 65536;

function fail(msg: string): never {
  throw new Error(msg);
}

/** Centre on the origin and scale so the largest of the three extents is 1.
 *  Idempotent for already-normalised data, so it is unconditional. */
function normalize(p: Float32Array): void {
  const n = p.length;
  if (n < 3) fail("mesh has no vertices");
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const ex = maxX - minX;
  const ey = maxY - minY;
  const ez = maxZ - minZ;
  const span = Math.max(ex, ey, ez);
  if (!(span > 0) || !isFinite(span)) fail("mesh has no extent");
  const s = 1 / span;
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  for (let i = 0; i < n; i += 3) {
    p[i] = (p[i] - cx) * s;
    p[i + 1] = (p[i + 1] - cy) * s;
    p[i + 2] = (p[i + 2] - cz) * s;
  }
}

/** Deduplicating edge sink. A triangle soup expanded naively triples the line
 *  count - every interior edge belongs to two faces, and a fan repeats its
 *  hub - so this is the difference between 8k and 24k lines on the same model.
 *  Key is `min * MAX_VERTICES + max`, which stays exact in a double. */
class Edges {
  readonly out: number[] = [];
  private seen = new Set<number>();
  add(a: number, b: number): void {
    if (a === b) return;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * MAX_VERTICES + hi;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.out.push(lo, hi);
  }
}

/** OBJ subset: `v`, `f`, `l`. Everything else (`vt`, `vn`, `g`, `o`, `s`,
 *  `usemtl`, `mtllib`, comments, blank lines) is skipped without inspection -
 *  `vn` in particular exists only so a normals-on export does not choke.
 *  Faces are fanned into a closed edge loop; `l` polylines stay open. Negative
 *  (relative) indices are honoured because Blender emits them for some
 *  exporters. Throws on malformed input; the loader catches. */
export function parseObj(text: string): MeshData {
  const pos: number[] = [];
  const edges = new Edges();
  const face: number[] = [];
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line === "" || line.charCodeAt(0) === 35 /* # */) continue;
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const tag = line.slice(0, sp);
    if (tag === "v") {
      const t = line.slice(sp + 1).split(/\s+/);
      const x = +t[0];
      const y = +t[1];
      const z = +t[2];
      if (!isFinite(x) || !isFinite(y) || !isFinite(z))
        fail(`obj: bad vertex on line ${li + 1}`);
      pos.push(x, y, z);
    } else if (tag === "f" || tag === "l") {
      const nv = pos.length / 3;
      const t = line.slice(sp + 1).split(/\s+/);
      face.length = 0;
      for (let i = 0; i < t.length; i++) {
        const tok = t[i];
        const slash = tok.indexOf("/");
        const raw = parseInt(slash < 0 ? tok : tok.slice(0, slash), 10);
        /* 0 is not a valid OBJ index (they are 1-based) and NaN is garbage;
           both fall out of the same falsy test */
        if (!raw) continue;
        const v = raw > 0 ? raw - 1 : nv + raw;
        if (v < 0 || v >= nv) continue;
        face.push(v);
      }
      const n = face.length;
      if (n < 2) continue;
      const last = tag === "f" ? n : n - 1;
      for (let i = 0; i < last; i++) edges.add(face[i], face[(i + 1) % n]);
    }
  }
  return finish(pos, edges.out, "obj");
}

/** `{ "p": [x,y,z, ...], "e": [i,j, ...] }`. `positions`/`edges` are accepted
 *  as long names so an inline object and a fetched file have one shape. */
export function parseEdgeJson(text: string): MeshData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("mesh json: not valid JSON");
  }
  if (!raw || typeof raw !== "object") fail("mesh json: not an object");
  const o = raw as Record<string, unknown>;
  const p = (o.p ?? o.positions) as number[] | undefined;
  const e = (o.e ?? o.edges) as number[] | undefined;
  if (!p || !e) fail("mesh json: expected { p: number[], e: number[] }");
  return fromArrays(p, e);
}

/** The in-memory form of `MeshSource`. Also the tail of both parsers. */
export function fromArrays(
  positions: ArrayLike<number>,
  edges: ArrayLike<number>
): MeshData {
  const p: number[] = [];
  for (let i = 0; i < positions.length; i++) p.push(positions[i]);
  const sink = new Edges();
  const nv = (p.length / 3) | 0;
  for (let i = 0; i + 1 < edges.length; i += 2) {
    const a = edges[i] | 0;
    const b = edges[i + 1] | 0;
    if (a < 0 || b < 0 || a >= nv || b >= nv) continue;
    sink.add(a, b);
  }
  return finish(p, sink.out, "mesh");
}

function finish(pos: number[], edges: number[], what: string): MeshData {
  const nv = pos.length / 3;
  if (nv < 2) fail(`${what}: no vertices`);
  if (nv > MAX_VERTICES)
    fail(
      `${what}: ${nv} vertices exceeds the ${MAX_VERTICES} Uint16 index limit - decimate the model`
    );
  if (edges.length < 2) fail(`${what}: no edges`);
  const positions = new Float32Array(pos);
  normalize(positions);
  return { positions, edges: new Uint16Array(edges) };
}

/** Fetch + sniff. Extension first, then the first non-space character, so a
 *  url with a query string or no extension still works. */
export async function loadMesh(src: MeshSource): Promise<MeshData> {
  if (typeof src !== "string") return fromArrays(src.positions, src.edges);
  if (typeof fetch !== "function") fail("mesh: fetch is unavailable");
  const res = await fetch(src, { credentials: "same-origin" });
  if (!res.ok) fail(`mesh: ${res.status} for ${src}`);
  const text = await res.text();
  const isObj = /\.obj(\?|#|$)/i.test(src);
  const isJson = /\.json(\?|#|$)/i.test(src);
  if (isObj) return parseObj(text);
  if (isJson) return parseEdgeJson(text);
  return text.trimStart().charCodeAt(0) === 123 /* { */
    ? parseEdgeJson(text)
    : parseObj(text);
}
