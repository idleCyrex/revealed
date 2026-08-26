export { RevealField } from "./core/field.js";
export { isSupported } from "./core/support.js";
export {
  presets,
  DEFAULT_EDGE,
  DEFAULT_BRUSH,
  DEFAULT_WAVE,
} from "./core/options.js";

/* the declared types of `DEFAULT_BRUSH` and `DEFAULT_WAVE`: exported so
   consumers can name what they are given, not just use it */
export type { ResolvedBrush, ResolvedWave } from "./core/options.js";

export type {
  BrushOptions,
  EdgeOptions,
  EdgePreset,
  IdleOptions,
  ImageSource,
  RevealOptions,
  SkeletonOptions,
  UvRect,
  WaveOptions,
} from "./core/types.js";
