import { contrastRatio, type Rgba } from './rgba-contrast'
import { oklchToRgba, rgbaToOklch, rgbToOklab } from './oklch-color-transform'

const SEARCH_STEPS = 24

/** Perceptual distance in OKLab; about 0.02 is a just-noticeable step. */
export function oklabDistance(a: Rgba, b: Rgba): number {
  const first = rgbToOklab(a)
  const second = rgbToOklab(b)
  return Math.hypot(first.l - second.l, first.a - second.a, first.b - second.b)
}

/**
 * The opaque color closest to `color` that reads at `min` on `against`, moving only OKLCH
 * lightness so the hue and chroma (the theme's character) stay; null when no lightness can.
 */
export function lightnessForContrast(color: Rgba, against: Rgba, min: number): Rgba | null {
  const start = rgbaToOklch([color[0], color[1], color[2], 1])
  const at = (l: number): Rgba => oklchToRgba({ ...start, l })
  const toward = (target: number): { color: Rgba; move: number } | null => {
    if (contrastRatio(at(target), against) < min) {
      return null
    }
    let near = start.l
    let far = target
    for (let step = 0; step < SEARCH_STEPS; step += 1) {
      const mid = (near + far) / 2
      if (contrastRatio(at(mid), against) >= min) {
        far = mid
      } else {
        near = mid
      }
    }
    return { color: at(far), move: Math.abs(far - start.l) }
  }
  // Why both ways: the smaller lightness move keeps the color closest to what was chosen.
  const options = [toward(0), toward(1)].filter((option) => option !== null)
  options.sort((left, right) => left.move - right.move)
  return options[0]?.color ?? null
}
