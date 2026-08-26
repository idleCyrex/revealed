# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.1

### Changed

- README now carries the media it always needed: an animated capture of a
  stroke tearing the plate open and the wave carrying on after it stops, a
  second capture contrasting `spotlight`, a plate of the three layers, and a
  strip of the six presets at the same stroke position. Nothing about the
  library changed - 0.1.0 shipped without the images only because they did
  not exist yet, and an npm README cannot be updated without a release.
- Licence attributed to idlee.xyz.
- Em dashes replaced with spaced hyphens throughout the source and docs.

## 0.1.0 - Initial release

### Added

- `RevealField` - the vanilla WebGL engine. Injects its own `<canvas>` plus
  the `front`/`back` `<img>` plates behind it, so a correct static image is
  always on screen even before (or without) GL.
- `<Revealed />` React component and `useRevealed()` hook (`revealed/react`
  entry point, ships its own `"use client"` banner), plus `RevealHandle`
  (`paint`/`clear`/`revealAll`/`play`/`pause`/`field`) via `ref`.
- Three-layer reveal model: required `front` and `back` images, optional
  `skeleton` line-art layer that ghosts onto `front` and sketches itself on
  in a loop (`draw` / `hold` / `pulse` modes), wiped away exactly where
  `back` is already uncovered.
- Wet, noise-carved edge: fbm-driven cut between the two plates with
  gradient-driven rim refraction, tunable via `EdgeOptions` (`scale`,
  `carve`, `detail`, `feather`, `threshold`, `refraction`,
  `refractionFalloff`, `speed`).
- Six edge presets: `liquid` (the default), `dissolve`, `ink`, `shatter`,
  `clean`, and `plain` for the quieter pre-wave look.
- A self-propagating wave. Velocity rides in the mask texture's two spare
  channels, so a stroke keeps spreading and tearing for about a second after
  the pointer stops, at no cost in render targets or programs
  (`BrushOptions.wave`, `WaveOptions`).
- Bubble character on the boundary: `EdgeOptions.bubble`, `bubbleScale` and
  `facet` leave islands of the front plate standing inside the uncovered area
  and detached specks outside it.
- `spotlight`: no trail at all, the reveal is only where the pointer is and
  closes immediately behind it. Reveal lifetime is one number seen three
  ways - `persist` is a heal rate of zero, `spotlight` is infinity, `trail`
  is everything between.
- Optional 3D wireframe skeletons behind the `revealed/mesh` subpath: a
  minimal OBJ subset and JSON edge-list parser, a hand-written matrix stack,
  pointer parallax, and a `"scan"` mode. Kept out of the core bundle, which
  never grows for anyone who does not import it.
- Capsule-brush pointer painting with configurable `radius`, fade `trail`,
  and stillness `holdTimeout`, plus a programmatic `paint(x, y, strength?)`
  API in plate uv space.
- Idle autopilot strokes so the effect breathes with no pointer input
  (`IdleOptions`: `enabled`, `strokes`, `speed`, `region`, `yieldAfter`).
- `progress` option and `onReveal` callback for scroll-driven or otherwise
  controlled reveals, measurable over a `measure` sub-rect.
- Automatic environment handling: `ResizeObserver`, `IntersectionObserver`
  pause off-screen, `visibilitychange` pause on hidden tabs,
  `prefers-reduced-motion: reduce` support (re-checked live), software
  renderer (SwiftShader/llvmpipe) refusal, and automatic recovery from
  WebGL context loss - all falling back to the static plates.
- `isSupported()` and cached, SSR-safe hardware-GL detection.
- Narrow-viewport image swapping via `{ src, small, smallMaxWidth }` sources.
- Full cleanup via `destroy()` - textures, FBOs, programs, buffers,
  observers, listeners, and the render loop are all freed.
- ESM + CJS + `.d.ts` builds for both entry points, plus a minified IIFE
  (`revealed.global.js`) for CDN/`<script>` use via `window.revealed`.
- Zero runtime dependencies; `react`/`react-dom` are optional peer
  dependencies used only by the `revealed/react` entry point.
