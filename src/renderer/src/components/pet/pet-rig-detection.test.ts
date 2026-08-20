import { describe, expect, it } from 'vitest'
import { detectLegs } from './pet-rig-detection'
import { blankImage } from './pet-raster-transform'
import type { RgbaImage } from './pet-image-cutout'

const W = 60
const H = 100

function shape(opaque: (x: number, y: number) => boolean): RgbaImage {
  const img = blankImage(W, H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!opaque(x, y)) {
        continue
      }
      const i = (y * W + x) * 4
      img.data[i] = 100
      img.data[i + 1] = 140
      img.data[i + 2] = 90
      img.data[i + 3] = 255
    }
  }
  return img
}

/** Head, torso, then two legs with a clear gap: what a rig should be found in. */
const biped = shape((x, y) => {
  if (y >= 10 && y < 30) {
    return x >= 24 && x < 36
  }
  if (y >= 30 && y < 62) {
    return x >= 18 && x < 42
  }
  if (y >= 62 && y < 90) {
    return (x >= 21 && x < 27) || (x >= 33 && x < 39)
  }
  return false
})

describe('detectLegs', () => {
  it('finds two legs either side of the gap between them', () => {
    const rig = detectLegs(biped)

    expect(rig).not.toBeNull()
    if (!rig) {
      return
    }
    const [left, right] = rig.legs
    expect(left.box[2]).toBeLessThanOrEqual(right.box[0])
    expect(left.box[0]).toBeGreaterThanOrEqual(20)
    expect(right.box[2]).toBeLessThanOrEqual(40)
  })

  it('puts the hips at the top of the legs, not at the feet', () => {
    const rig = detectLegs(biped)

    expect(rig).not.toBeNull()
    if (!rig) {
      return
    }
    for (const leg of rig.legs) {
      expect(leg.pivot[1]).toBeLessThan(leg.box[3])
      expect(leg.pivot[1]).toBeLessThanOrEqual(leg.box[1] + 4)
    }
  })

  it('mirrors exactly one leg so both feet face the same way', () => {
    const rig = detectLegs(biped)

    expect(rig?.legs.filter((l) => l.mirror)).toHaveLength(1)
  })

  it('gives up on a shape with no gap rather than inventing legs', () => {
    // A solid pillar: the walk would tear it in half down an imaginary seam.
    const pillar = shape((x, y) => y >= 10 && y < 90 && x >= 20 && x < 40)

    expect(detectLegs(pillar)).toBeNull()
  })

  it('gives up on a shape with too many gaps to be a pair of legs', () => {
    const comb = shape((x, y) => y >= 60 && y < 90 && x % 8 < 4 && x >= 16 && x < 48)

    expect(detectLegs(comb)).toBeNull()
  })

  it('gives up when the legs are a sliver of the body', () => {
    // Two hairs under a big blob: rotating them would read as a glitch.
    const blobOnPins = shape((x, y) => {
      if (y >= 10 && y < 84) {
        return x >= 14 && x < 46
      }
      return y >= 84 && y < 90 && (x === 20 || x === 40)
    })

    expect(detectLegs(blobOnPins)).toBeNull()
  })

  it('gives up on an empty image instead of throwing', () => {
    expect(detectLegs(blankImage(W, H))).toBeNull()
  })
})
