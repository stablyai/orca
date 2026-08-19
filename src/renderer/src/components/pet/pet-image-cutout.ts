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

export const CUTOUT_TUNING = {
  /** Alpha below this counts as transparent. */
  alphaThreshold: 128,
  /** An image is treated as pre-cut once this share of it is transparent —
   *  below it, stray soft edges would be mistaken for a deliberate cutout. */
  minTransparentShareForAlpha: 0.02,
  /** Squared RGB distance a pixel may sit from a corner's colour and still be
   *  flooded. Photo backgrounds are never perfectly flat. */
  floodToleranceSq: 24 * 24 * 3
} as const

/** Separates subject from background without a segmentation model.
 *
 *  Order matters: an image that already carries alpha was cut out by someone
 *  with far more to work with than a corner fill, so it is used as-is. Only when
 *  we have to guess do we flood inward from the corners, which works on flat
 *  backgrounds and gives up honestly on busy ones — leaving the quality gate to
 *  refuse the upload rather than producing a mangled pet. */
export function deriveCutout(image: RgbaImage): Cutout {
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
  floodFromCorners(image, mask)
  return { mask, source: 'derived' }
}

function floodFromCorners(image: RgbaImage, mask: Uint8Array): void {
  const { data, width, height } = image
  const corners = [0, width - 1, (height - 1) * width, height * width - 1]
  const seen = new Uint8Array(width * height)

  for (const corner of corners) {
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
      if (dr * dr + dg * dg + db * db > CUTOUT_TUNING.floodToleranceSq) {
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
