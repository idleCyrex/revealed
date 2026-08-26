# Contributing to revealed

Thanks for taking the time. This is a small library with a narrow remit, so the fastest
way to get a change merged is to know what it is trying to be.

## The one hard rule

**Zero runtime dependencies.** Not "few". Zero. A pull request that adds one to
`dependencies` will not be merged, however small the package. React is an optional peer,
used only by the `revealed/react` entry.

Everything else - the hand-written 4×4 matrix stack, the OBJ parser, the noise functions -
exists because pulling in a library for it would have cost more than writing it.

## Running it

```bash
npm install
npm run build      # tsup: ESM + CJS + types, the react entry, the mesh entry, the CDN bundle
npm run typecheck  # tsc --noEmit
npm run dev        # tsup --watch
```

`npm run build` overwrites `dist` in place so a dev server watching it keeps working.
`npm run rebuild` wipes `dist` first - use it if you suspect a stale artifact. `prepack`
runs the clean build, so `npm publish` always ships a pristine `dist`.

There is no test suite. This is a visual, GPU-bound library: the things that break are
driver behaviour, precision, and what a shader actually draws, none of which a unit test
catches. Changes are verified by looking at them, in a real browser, on real hardware.
If you change rendering, say in the pull request what you looked at and on what GPU.

## The layout

```
src/index.ts            public surface: RevealField, isSupported, presets, types
src/core/
  field.ts              the instance: render loop, GL lifecycle, pointer, observers
  options.ts            defaults, presets, normalisation - the meaning of every option
  mask.ts               the ping-pong feedback target
  strokes.ts            the idle autopilot
  support.ts            hardware-GL detection
  gl.ts                 compile/link/texture/FBO helpers
  shaders/
    mask.frag.ts        the feedback pass: brush, decay, and the velocity field
    display.frag.ts     the composite: carve, cut, refraction, skeleton stamp
    reduce.frag.ts      the 1×1 "how much is uncovered" pass
src/react/index.tsx     <Revealed /> and useRevealed()
src/mesh/               the optional 3D wireframe skeleton (revealed/mesh subpath)
```

Three passes run per frame: mask → display → reduce. The mask is RGBA8; R is the reveal,
G and B carry the velocity field that makes the wave propagate. If you are touching the
shaders, that channel budget is the constraint to keep in mind - there are no float
textures and no extensions.

## Adding a preset

Presets are `EdgeOptions` partials in `src/core/options.ts`, plus an entry in `PRESET_WAVE`
saying whether the name implies the wave. Add both, and add the preset to the table in
`README.md`. A preset should be a *look* someone would ask for by name, not a parameter
dump - if you cannot describe it in three words, it is probably a config, not a preset.

## Style

- Comments explain **why**, not what. If a number is empirical, say what it was measured
  against; if a line looks wrong but is deliberate, say why. Do not narrate the code.
- Match the surrounding code rather than your own preferences.
- Prettier config is in the repo; run it before opening a pull request.
- Keep the public API surface small. A new option needs a real use case, a default that
  does nothing surprising, and a row in the README's option table.

## Proposing something larger

Open an issue first and describe the effect you want, ideally with a reference - a site, a
video, a shader. That is how the wave and the bubble character got in: someone pointed at
a page and asked why ours did not do that.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
