import { describe, expect, it } from 'vitest'
import { deriveCutout, type RgbaImage } from './pet-image-cutout'
import { assessCutout } from './pet-cutout-quality'
import { blankImage } from './pet-raster-transform'

const W = 20
const H = 20

/** Builds an image from a per-pixel colour, so tests read as pictures. */
function image(at: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = at(x, y)
      const i = (y * W + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return { data, width: W, height: H }
}

const inSubject = (x: number, y: number): boolean => x >= 6 && x < 14 && y >= 5 && y < 16

describe('deriveCutout', () => {
  it('uses the image own alpha when it already carries a cutout', () => {
    const withAlpha = image((x, y) => (inSubject(x, y) ? [200, 40, 40, 255] : [0, 0, 0, 0]))

    const { mask, source } = deriveCutout(withAlpha)

    expect(source).toBe('alpha')
    expect(mask[5 * W + 8]).toBe(255)
    expect(mask[0]).toBe(0)
  })

  it('floods a flat background away from the corners', () => {
    const flatBackground = image((x, y) =>
      inSubject(x, y) ? [200, 40, 40, 255] : [250, 250, 250, 255]
    )

    const { mask, source } = deriveCutout(flatBackground)

    expect(source).toBe('derived')
    expect(mask[8 * W + 8]).toBe(255)
    expect(mask[0]).toBe(0)
    expect(mask[W - 1]).toBe(0)
  })

  it('tolerates the slight noise a photo background carries', () => {
    const noisy = image((x, y) =>
      inSubject(x, y) ? [200, 40, 40, 255] : [248 + ((x * 7 + y * 3) % 5), 249, 250, 255]
    )

    const { mask } = deriveCutout(noisy)

    expect(mask[8 * W + 8]).toBe(255)
    expect(mask[0]).toBe(0)
  })

  it('keeps a subject that happens to share the background colour inside it', () => {
    // A white patch in the middle of the subject must not be flooded: the fill
    // only reaches what connects to a corner.
    const withHole = image((x, y) => {
      if (x >= 9 && x < 11 && y >= 9 && y < 11) {
        return [250, 250, 250, 255]
      }
      return inSubject(x, y) ? [200, 40, 40, 255] : [250, 250, 250, 255]
    })

    const { mask } = deriveCutout(withHole)

    expect(mask[10 * W + 10]).toBe(255)
  })

  it('gives up on a noisy background instead of eating into the image', () => {
    // High-frequency noise: every neighbour is outside the tolerance, so the
    // flood stops at the corner it started from.
    const noisyBackground = image((x, y) =>
      inSubject(x, y) ? [200, 40, 40, 255] : [(x * 37 + y * 61) % 200, 90, 140, 255]
    )

    const { mask, source } = deriveCutout(noisyBackground)

    expect(source).toBe('derived')
    const kept = mask.reduce((n, v) => n + (v === 255 ? 1 : 0), 0)
    // Almost nothing removed — refusing this is the quality gate's job, not the
    // cutout's, and it does refuse it.
    expect(kept / mask.length).toBeGreaterThan(0.9)
    expect(assessCutout(mask, W, H, source)).toEqual({
      ok: false,
      reason: 'background-not-separable'
    })
  })

  it('hands a flooded flat background on to the gate as a usable subject', () => {
    const flatBackground = image((x, y) =>
      inSubject(x, y) ? [200, 40, 40, 255] : [250, 250, 250, 255]
    )

    const { mask, source } = deriveCutout(flatBackground)

    // The plain block silhouette is uniform, so the gate refuses it as shapeless
    // — the two modules agreeing is the point of this test.
    expect(assessCutout(mask, W, H, source)).toEqual({
      ok: false,
      reason: 'no-character-shape'
    })
  })
})

describe('deriveCutout corner independence', () => {
  /** Three flat bands: the top corners' colour, a middle stripe only the bottom
   *  corners are close to, and the bottom corners' colour. */
  function bandedBackground(): RgbaImage {
    const img = blankImage(8, 8)
    for (let y = 0; y < 8; y++) {
      const shade = y < 3 ? 100 : y === 3 ? 200 : 210
      for (let x = 0; x < 8; x++) {
        const i = (y * 8 + x) * 4
        img.data[i] = shade
        img.data[i + 1] = shade
        img.data[i + 2] = shade
        img.data[i + 3] = 255
      }
    }
    return img
  }

  it('lets a later corner clear a stripe an earlier one rejected', () => {
    // The top fill rejects the stripe, but the bottom fill sits ten steps away
    // from it. Sharing one visited set let the rejection stand for good, and
    // stranded background in the middle of the image reads as a subject.
    const { mask } = deriveCutout(bandedBackground())

    expect(Array.from(mask.slice(3 * 8, 4 * 8))).toEqual(Array.from({ length: 8 }, () => 0))
  })
})
