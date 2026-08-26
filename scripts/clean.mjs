/* One deterministic wipe of dist, for a pristine build.
   Not part of `npm run build`: the three tsup configs build CONCURRENTLY, and
   letting each clean its own globs raced (dist/react/*.d.ts went missing on
   rebuilds) - but wiping dist up front on EVERY build breaks a running
   `next dev`, which resolves `revealed` through this directory and crashes the
   moment it disappears. So `build` overwrites in place, and this runs only for
   `rebuild` and `prepack`, where a stale artifact would actually matter. */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

rmSync(fileURLToPath(new URL("../dist", import.meta.url)), {
  recursive: true,
  force: true,
});
