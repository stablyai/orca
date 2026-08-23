import { describe, expect, it } from 'vitest'
import { blankImage, drawTransformed } from './pet-raster-transform'
import type { RgbaImage } from './pet-image-cutout'

const W = 9
const H = 9

/** One opaque pixel at (x, y), so a transform's effect is unambiguous. */
function dot(x: number, y: number): RgbaImage {
  const img = blankImage(W, H)
  const i = (y * W + x) * 4
  img.data[i] = 255
  img.data[i + 1] = 128
  img.data[i + 2] = 64
  img.data[i + 3] = 255
  return img
}

function litPixels(img: RgbaImage): [number, number][] {
  const lit: [number, number][] = []
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] >= 128) {
        lit.push([x, y])
      }
    }
  }
  return lit
}

describe('drawTransformed', () => {
  it('copies the source through an identity transform', () => {
    const dst = blankImage(W, H)

    drawTransformed(dst, dot(4, 2), {})

    expect(litPixels(dst)).toEqual([[4, 2]])
  })

  it('carries colour across, not just coverage', () => {
    const dst = blankImage(W, H)

    drawTransformed(dst, dot(4, 2), {})

    const i = (2 * W + 4) * 4
    expect([dst.data[i], dst.data[i + 1], dst.data[i + 2]]).toEqual([255, 128, 64])
  })

  it('translates by whole pixels', () => {
    const dst = blankImage(W, H)

    drawTransformed(dst, dot(4, 2), { translateX: 2, translateY: 3 })

    expect(litPixels(dst)).toEqual([[6, 5]])
  })

  it('rotates a quarter turn about a chosen pivot', () => {
    const dst = blankImage(W, H)
    // The pivot is the centre; a point directly above it lands to its right
    // under a positive (clockwise, y-down) quarter turn.
    drawTransformed(dst, dot(4, 2), {
      pivotX: 4,
      pivotY: 4,
      rotateDeg: 90
    })

    expect(litPixels(dst)).toEqual([[6, 4]])
  })

  it('scales about the pivot rather than the corner', () => {
    const dst = blankImage(W, H)

    drawTransformed(dst, dot(4, 2), { pivotX: 4, pivotY: 4, scaleY: 2 })

    // Two rows above the pivot becomes four.
    expect(litPixels(dst).map(([, y]) => y)).toContain(0)
  })

  it('drops what falls outside the destination instead of wrapping', () => {
    const dst = blankImage(W, H)

    drawTransformed(dst, dot(1, 1), { translateX: -5, translateY: -5 })

    expect(litPixels(dst)).toEqual([])
  })

  it('leaves what is already drawn where the source is transparent', () => {
    const dst = blankImage(W, H)
    drawTransformed(dst, dot(0, 0), {})

    drawTransformed(dst, dot(8, 8), {})

    expect(litPixels(dst)).toEqual([
      [0, 0],
      [8, 8]
    ])
  })

  it('writes nothing outside a clip rectangle', () => {
    const dst = blankImage(W, H)

    drawTransformed(dst, dot(4, 2), { clip: { x0: 5, y0: 0, x1: 9, y1: 9 } })

    expect(litPixels(dst)).toEqual([])
  })

  it('still draws what falls inside the clip rectangle', () => {
    const dst = blankImage(W, H)

    drawTransformed(dst, dot(4, 2), { clip: { x0: 4, y0: 2, x1: 5, y1: 3 } })

    expect(litPixels(dst)).toEqual([[4, 2]])
  })
})
