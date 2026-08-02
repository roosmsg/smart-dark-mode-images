/**
 * Per-image classification for the invert-by-default rule. The only
 * decision left is whether an image is already dark ("keep") or not
 * ("invert" — the default for everything else, including images that
 * cannot be read).
 *
 * The analysis samples the image into a small offscreen canvas (never more
 * than SAMPLE_SIZE px on the longest side) and computes pixel statistics.
 * Nothing is written back anywhere — the original image is untouched and
 * no copies are kept; only the verdict is cached by the caller.
 */

export type Verdict = "invert" | "keep";

export interface PixelStats {
  opaqueFrac: number;
  /** Fraction of opaque pixels with lum < 0.4. */
  darkFrac: number;
}

export interface ClassifyResult {
  verdict: Verdict;
  stats: PixelStats;
}

const SAMPLE_SIZE = 64;

function computeStats(data: Uint8ClampedArray, w: number, h: number): PixelStats {
  const n = w * h;
  let opaque = 0;
  let dark = 0;
  for (let i = 0; i < n * 4; i += 4) {
    if (data[i + 3] < 13) continue; // < ~5% alpha: transparent
    opaque++;
    const lum =
      (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    if (lum < 0.4) dark++;
  }
  return {
    opaqueFrac: n === 0 ? 0 : opaque / n,
    darkFrac: opaque === 0 ? 0 : dark / opaque,
  };
}

function decide(s: PixelStats): Verdict {
  // A mostly opaque, mostly dark image already fits a dark theme: leave it
  // untouched. The opacity guard keeps dark-on-transparent content
  // (formulas, hand-drawn strokes) on the invert path, where inversion is
  // what makes it visible against a dark background.
  if (s.opaqueFrac > 0.9 && s.darkFrac >= 0.5) {
    return "keep";
  }
  return "invert";
}

/**
 * Classify any drawable source (an <img>, or an ImageBitmap decoded from
 * bytes fetched via requestUrl for CORS-restricted remote images).
 * Returns null when the pixels cannot be read.
 */
export function classifySource(
  source: CanvasImageSource,
  sw: number,
  sh: number
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
    return { verdict: decide(stats), stats };
  } catch {
    // SecurityError from a tainted canvas (remote image without CORS).
    return null;
  }
}

/** Classify a loaded <img> element in place. */
export function classifyImage(img: HTMLImageElement): ClassifyResult | null {
  // Fall back to layout size for SVGs that expose no intrinsic dimensions
  // (viewBox-only SVGs report naturalWidth 0 but rasterize at layout size).
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  return classifySource(img, w, h);
}
