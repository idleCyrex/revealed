import { defineConfig } from "tsup";

/* Three separate builds rather than one multi-entry build, because only the
   React entry may carry the "use client" banner: a banner is per-build in tsup,
   and a `"use client"` at the top of dist/index.js would force every bundler
   that sees the core entry into a client boundary it does not need.

   The three run concurrently, so none of them cleans: a per-config clean races
   the others' output (dist/react/*.d.ts went missing on rebuilds). The whole
   dist is wiped once, before tsup starts, by scripts/clean.mjs. */
export default defineConfig([
  // 1. core: no React, no directives, dual ESM/CJS + types
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    target: "es2019",
    dts: true,
    sourcemap: true,
    clean: false,
    outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  },
  // 2. React entry. `../index.js` stays external so the two entries share one
  //    module instance at runtime instead of the core being inlined twice.
  //    NOTE: no `treeshake` here - tsup's tree-shaking step runs the bundle
  //    through Rollup, which strips module-level directives and would drop the
  //    "use client" banner this entry exists to carry.
  {
    entry: { index: "src/react/index.tsx" },
    outDir: "dist/react",
    format: ["esm", "cjs"],
    target: "es2019",
    dts: true,
    sourcemap: true,
    clean: false,
    external: ["react", "react-dom", "../index.js"],
    banner: { js: '"use client";' },
    outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  },
  // 3. CDN build: window.revealed, minified, core only
  {
    entry: { revealed: "src/index.ts" },
    format: ["iife"],
    globalName: "revealed",
    target: "es2019",
    minify: true,
    sourcemap: false,
    clean: false,
    outExtension: () => ({ js: ".global.js" }),
  },
  // 4. Optional 3D wireframe skeleton, behind the `revealed/mesh` subpath so the
  //    core stays lean: it is ~6.6 kB gzipped and needs a decimated hero mesh,
  //    which most consumers do not have. Imports nothing outside src/mesh.
  {
    entry: { index: "src/mesh/index.ts" },
    outDir: "dist/mesh",
    format: ["esm", "cjs"],
    target: "es2019",
    dts: true,
    sourcemap: true,
    clean: false,
    outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  },
]);
