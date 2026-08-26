#!/usr/bin/env node
/* obj-to-edges - Wavefront OBJ to the JSON edge list `revealed/mesh` ships.
 *
 *   node src/mesh/obj-to-edges.mjs helmet.obj helmet.json [--precision 4]
 *
 * Why bother, when the runtime can parse OBJ itself: an OBJ carries every edge
 * two or three times (each interior edge belongs to two faces), plus normals,
 * uvs, materials and 6-9 significant digits per coordinate. Deduplicating and
 * rounding offline typically takes a 1.4 MB export down to 90 KB of JSON, and
 * moves the parse from ~90 lines of string splitting to one JSON.parse.
 *
 * Budget: 1,500-3,000 edges for a hero. Decimate in Blender before exporting:
 * a wireframe at ~0.5 alpha with no depth test reads as grey mush well before
 * it becomes a performance problem, so the ceiling is visual, not technical.
 *
 * This duplicates ~40 lines of parse.ts on purpose: it must run under bare
 * `node` with no build step, and the two are pinned by the shared fixture test
 * in the harness. Keep them in step.
 */

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const [input, output] = args.filter((a) => !a.startsWith("--"));
const pi = args.indexOf("--precision");
const PRECISION = pi >= 0 ? Number(args[pi + 1]) : 4;
if (!input || !output) {
  console.error("usage: obj-to-edges.mjs <in.obj> <out.json> [--precision 4]");
  process.exit(1);
}

const pos = [];
const seen = new Set();
const edges = [];
const KEY = 65536;

const addEdge = (a, b) => {
  if (a === b) return;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const key = lo * KEY + hi;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(lo, hi);
};

for (const raw of readFileSync(input, "utf8").split("\n")) {
  const line = raw.trim();
  if (!line || line[0] === "#") continue;
  const sp = line.indexOf(" ");
  if (sp < 0) continue;
  const tag = line.slice(0, sp);
  const rest = line.slice(sp + 1);
  if (tag === "v") {
    const t = rest.split(/\s+/);
    pos.push(+t[0], +t[1], +t[2]);
  } else if (tag === "f" || tag === "l") {
    const nv = pos.length / 3;
    const face = [];
    for (const tok of rest.split(/\s+/)) {
      const slash = tok.indexOf("/");
      const n = parseInt(slash < 0 ? tok : tok.slice(0, slash), 10);
      if (!n) continue;
      const v = n > 0 ? n - 1 : nv + n;
      if (v >= 0 && v < nv) face.push(v);
    }
    if (face.length < 2) continue;
    const last = tag === "f" ? face.length : face.length - 1;
    for (let i = 0; i < last; i++) addEdge(face[i], face[(i + 1) % face.length]);
  }
}

const nv = pos.length / 3;
if (nv < 2) throw new Error("no vertices");
if (nv > KEY) throw new Error(`${nv} vertices exceeds the 65536 Uint16 limit`);
if (!edges.length) throw new Error("no edges");

/* centre on the origin and scale the largest extent to 1, so exporter units and
   origin do not matter and `meshScale` means "fraction of the plate height" */
const lo = [Infinity, Infinity, Infinity];
const hi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i++) {
  const a = i % 3;
  if (pos[i] < lo[a]) lo[a] = pos[i];
  if (pos[i] > hi[a]) hi[a] = pos[i];
}
const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
if (!(span > 0)) throw new Error("mesh has no extent");
const p = new Array(pos.length);
for (let i = 0; i < pos.length; i++) {
  const a = i % 3;
  p[i] = +(((pos[i] - (lo[a] + hi[a]) / 2) / span).toFixed(PRECISION));
}

writeFileSync(output, JSON.stringify({ p, e: edges }));
console.log(
  `${nv} vertices, ${edges.length / 2} edges -> ${output}` +
    (edges.length / 2 > 3000 ? "  [over the 3,000-edge budget: decimate]" : "")
);
