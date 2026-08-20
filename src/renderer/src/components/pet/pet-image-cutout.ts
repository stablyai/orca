import type { CutoutSource } from './pet-cutout-quality'

/** Plain pixel buffer, shaped like `ImageData` but constructible without a DOM
 *  so the pipeline stays unit-testable. */
export type RgbaImage = {
  data: Uint8ClampedArray
  width: number
  height: number
}

export type Cutout = {
  /** 255 = subject, 0 = background. */
  mask: Uint8Array
  source: CutoutSource
}

/** How far from a corner's colour a pixel may sit and still count as
 *  background, as a per-channel radius. Exposed because no single value suits
 *  both a flat studio backdrop and a gradient — the user can see which they
 *  have, and the pipeline cannot. */
export const BACKGROUND_TOLERANCE = {
  min: 4,
  max: 96,
  default: 24
} as const

export const CUTOUT_TUNING = {
  /** Alpha below this counts as transparent. */
  alphaThreshold: 128,
  /** An image is treated as pre-cut once this share of it is transparent —
   *  below it, stray soft edges would be mistaken for a deliberate cutout. */
  minTransparentShareForAlpha: 0.02
} as const

/** Turns a per-channel radius into the squared RGB distance the fill compares. */
function floodToleranceSq(radius: number): number {
  const clamped = Math.min(
    BACKGROUND_TOLERANCE.max,
    Math.max(BACKGROUND_TOLERANCE.min, Math.round(radius))
  )
  return clamped * clamped * 3
}

/** Separates subject from background without a segmentation model.
 *
 *  Order matters: an image that already carries alpha was cut out by someone
 *  with far more to work with than a corner fill, so it is used as-is. Only when
 *  we have to guess do we flood inward from the corners, which works on flat
 *  backgrounds and gives up honestly on busy ones — leaving the quality gate to
 *  refuse the upload rather than producing a mangled pet. */
export function deriveCutout(
  image: RgbaImage,
  tolerance: number = BACKGROUND_TOLERANCE.default
): Cutout {
  const { data, width, height } = image
  const pixels = width * height
  const mask = new Uint8Array(pixels)

  let transparent = 0
  for (let p = 0; p < pixels; p++) {
    const opaque = data[p * 4 + 3] >= CUTOUT_TUNING.alphaThreshold
    mask[p] = opaque ? 255 : 0
    if (!opaque) {
      transparent++
    }
  }
  if (transparent / pixels >= CUTOUT_TUNING.minTransparentShareForAlpha) {
    return { mask, source: 'alpha' }
  }

  mask.fill(255)
  floodFromCorners(image, mask, floodToleranceSq(tolerance))
  return { mask, source: 'derived' }
}

function floodFromCorners(image: RgbaImage, mask: Uint8Array, toleranceSq: number): void {
  const { data, width, height } = image
  const corners = [0, width - 1, (height - 1) * width, height * width - 1]
  const seen = new Uint8Array(width * height)

  for (const corner of corners) {
    // Why: a rejection belongs to the corner that made it. Sharing one visited
    // set let the first corner's refusals stand for all of them, stranding
    // background the others were well within tolerance of — and walling off
    // whatever lay beyond it.
    seen.fill(0)
    // Why: each corner floods against its own colour. A gradient or a busy photo
    // simply stops early instead of eating the subject.
    const target = [data[corner * 4], data[corner * 4 + 1], data[corner * 4 + 2]] as const
    const stack = [corner]
    while (stack.length > 0) {
      const at = stack.pop() as number
      if (seen[at]) {
        continue
      }
      seen[at] = 1
      const i = at * 4
      const dr = data[i] - target[0]
      const dg = data[i + 1] - target[1]
      const db = data[i + 2] - target[2]
      if (dr * dr + dg * dg + db * db > toleranceSq) {
        continue
      }
      mask[at] = 0
      const x = at % width
      const y = (at / width) | 0
      if (x > 0) {
        stack.push(at - 1)
      }
      if (x < width - 1) {
        stack.push(at + 1)
      }
      if (y > 0) {
        stack.push(at - width)
      }
      if (y < height - 1) {
        stack.push(at + width)
      }
    }
  }
}
