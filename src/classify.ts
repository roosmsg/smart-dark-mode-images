/**
 * Per-image classification: decide whether an image should be inverted in
 * dark mode ("invert") or left alone ("keep").
 *
 * The analysis samples the image into a small offscreen canvas (never more
 * than SAMPLE_SIZE px on the longest side) and computes pixel statistics.
 * Nothing is written back anywhere — the original image is untouched and
 * no copies are kept; only the verdict is cached by the caller.
 *
 * The classifier combines luminance, transparency, saturation, palette,
 * border-lightness, and flat-region measurements. Mostly light,
 * unsaturated images are adapted, while ambiguous images are preserved.
 */

export type Verdict = "invert" | "keep";

export interface ClassifyOptions {
  /** Light pixel (lum > 0.7) ratio above which an unsaturated image counts as light-background. */
  lightBgThreshold: number;
  /** Saturated-pixel ratio at or above which an image counts as photo-like. */
  saturatedThreshold: number;
}

export const DEFAULT_CLASSIFY: ClassifyOptions = {
  lightBgThreshold: 0.58,
  saturatedThreshold: 0.18,
};

export interface PixelStats {
  opaqueFrac: number;
  /** The following are fractions of opaque pixels. */
  darkFrac: number; // dark, lum < 0.4
  inkFrac: number; // near-black, lum < 0.24
  lightFrac: number; // light, lum > 0.7
  nearWhiteFrac: number; // near-white, lum > 0.82
  satFrac: number; // saturated, HSV S > 0.35
  flatFrac: number; // same quantized color as right neighbor (solid regions)
  borderLightFrac: number; // near-white among opaque border pixels
  uniqueColors: number; // distinct 4-bit-per-channel buckets, capped at 1024
}

export interface ClassifyResult {
  verdict: Verdict;
  stats: PixelStats;
  rule: string;
}

const SAMPLE_SIZE = 64;

function computeStats(data: Uint8ClampedArray, w: number, h: number): PixelStats {
  const n = w * h;
  let opaque = 0;
  let dark = 0;
  let ink = 0;
  let light = 0;
  let nearWhite = 0;
  let saturated = 0;
  let flat = 0;
  let flatPairs = 0;
  let borderOpaque = 0;
  let borderLight = 0;
  const colors = new Set<number>();

  const bucketOf = (i: number) =>
    ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a < 13) continue; // < ~5% alpha: transparent
      opaque++;

      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const sat = max === 0 ? 0 : (max - min) / max;

      if (lum < 0.4) dark++;
      if (lum < 0.24) ink++;
      if (lum > 0.7) light++;
      if (lum > 0.82) nearWhite++;
      if (sat > 0.35) saturated++;

      if (colors.size < 1024) colors.add(bucketOf(i));

      if (x < w - 1 && data[i + 7] >= 13) {
        flatPairs++;
        if (bucketOf(i) === bucketOf(i + 4)) flat++;
      }

      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        borderOpaque++;
        if (lum > 0.82) borderLight++;
      }
    }
  }

  return {
    opaqueFrac: n === 0 ? 0 : opaque / n,
    darkFrac: opaque === 0 ? 0 : dark / opaque,
    inkFrac: opaque === 0 ? 0 : ink / opaque,
    lightFrac: opaque === 0 ? 0 : light / opaque,
    nearWhiteFrac: opaque === 0 ? 0 : nearWhite / opaque,
    satFrac: opaque === 0 ? 0 : saturated / opaque,
    flatFrac: flatPairs === 0 ? 0 : flat / flatPairs,
    borderLightFrac: borderOpaque === 0 ? 0 : borderLight / borderOpaque,
    uniqueColors: colors.size,
  };
}

function decide(s: PixelStats, opts: ClassifyOptions): { verdict: Verdict; rule: string } {
  const transFrac = 1 - s.opaqueFrac;

  // A mostly opaque, mostly dark image already fits a dark theme: never
  // invert or dim it. The opacity guard lets dark-on-transparent images
  // continue to the dedicated inversion rules below.
  if (s.opaqueFrac > 0.9 && s.darkFrac >= 0.5) {
    return { verdict: "keep", rule: "already-dark" };
  }

  // Some transparency plus predominantly dark opaque pixels means the
  // content can disappear against a dark background — invert.
  if (transFrac >= 0.1 && s.darkFrac >= 0.7) {
    return { verdict: "invert", rule: "dark-on-transparent" };
  }

  // Otherwise-heavily-transparent image (formulas, hand-drawn strokes):
  // invert if the strokes lean dark; light strokes already read fine.
  if (s.opaqueFrac < 0.6) {
    return s.darkFrac > s.lightFrac
      ? { verdict: "invert", rule: "transparent-dark-strokes" }
      : { verdict: "keep", rule: "transparent-light-strokes" };
  }

  // Mostly light and unsaturated images are adapted before color-rich
  // image checks. Light means lum > 0.7; softer colors live in the
  // 0.7–0.82 band, so demanding near-white here misses useful cases.
  if (s.lightFrac > opts.lightBgThreshold && s.satFrac < opts.saturatedThreshold) {
    return { verdict: "invert", rule: "light-unsaturated-document" };
  }

  // White-background artwork (colorful charts, plots): dominated by
  // near-white plus large solid regions. Photos have neither.
  if (s.nearWhiteFrac > 0.65 && s.flatFrac > 0.35) {
    return { verdict: "invert", rule: "white-bg-artwork" };
  }

  // Flat-color artwork on a light page background (infographics, wheel
  // charts, vivid diagrams): large solid fills, a light border, and a small
  // palette. Photos have organic texture (low flatness) and rich palettes,
  // so all three guards together don't match them.
  if (s.flatFrac > 0.5 && s.borderLightFrac > 0.7 && s.uniqueColors < 512) {
    return { verdict: "invert", rule: "flat-artwork-light-border" };
  }

  // Photo-like: saturated midtones or a rich color palette.
  if (s.satFrac >= opts.saturatedThreshold || s.uniqueColors >= 512) {
    return { verdict: "keep", rule: "photo-like" };
  }

  // Bimodal ink-on-paper (near-black ink + near-white paper dominate) with
  // a light background or light border: a diagram or scan that missed the
  // rules above. Grayscale photos are midtone-heavy and don't get here.
  if (
    s.inkFrac + s.nearWhiteFrac > 0.6 &&
    (s.nearWhiteFrac > 0.45 || s.borderLightFrac > 0.7)
  ) {
    return { verdict: "invert", rule: "ink-on-paper" };
  }

  // Ambiguous — preserve unchanged (fail safe).
  return { verdict: "keep", rule: "ambiguous-fail-safe" };
}

/**
 * Classify any drawable source (an <img>, or an ImageBitmap decoded from
 * bytes fetched via requestUrl for CORS-restricted remote images).
 * Returns null when the pixels cannot be read.
 */
export function classifySource(
  source: CanvasImageSource,
  sw: number,
  sh: number,
  opts: ClassifyOptions = DEFAULT_CLASSIFY
): ClassifyResult | null {
  if (!sw || !sh) return null;

  const scale = Math.min(1, SAMPLE_SIZE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const stats = computeStats(data, w, h);
    return { ...decide(stats, opts), stats };
  } catch {
    // SecurityError from a tainted canvas (remote image without CORS).
    return null;
  }
}

/** Classify a loaded <img> element in place. */
export function classifyImage(
  img: HTMLImageElement,
  opts: ClassifyOptions = DEFAULT_CLASSIFY
): ClassifyResult | null {
  // Fall back to layout size for SVGs that expose no intrinsic dimensions
  // (viewBox-only SVGs report naturalWidth 0 but rasterize at layout size).
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  return classifySource(img, w, h, opts);
}
