import { describe, expect, it } from 'vitest'
import { clampCropRect, cropImage, FULL_CROP } from './pet-image-crop'
import { blankImage } from './pet-raster-transform'
import type { RgbaImage } from './pet-image-cutout'

/** Each pixel carries its own coordinates, so a crop can be checked by value. */
function coordinateImage(width: number, height: number): RgbaImage {
  const img = blankImage(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      img.data[i] = x
      img.data[i + 1] = y
      img.data[i + 2] = 0
      img.data[i + 3] = 255
    }
  }
  return img
}

describe('cropImage', () => {
  it('keeps only the requested rectangle', () => {
    const out = cropImage(coordinateImage(10, 8), { x: 3, y: 2, width: 4, height: 5 })

    expect(out.width).toBe(4)
    expect(out.height).toBe(5)
    expect([out.data[0], out.data[1]]).toEqual([3, 2])
    const last = (4 * 5 - 1) * 4
    expect([out.data[last], out.data[last + 1]]).toEqual([6, 6])
  })

  it('returns the image itself when the rectangle covers everything', () => {
    const img = coordinateImage(6, 6)

    expect(cropImage(img, FULL_CROP)).toBe(img)
  })

  it('does not read past the edge when the rectangle overhangs', () => {
    const out = cropImage(coordinateImage(4, 4), { x: 2, y: 2, width: 10, height: 10 })

    expect([out.width, out.height]).toEqual([2, 2])
  })
})

describe('clampCropRect', () => {
  it('leaves a rectangle that already fits', () => {
    expect(clampCropRect({ x: 1, y: 1, width: 2, height: 2 }, 8, 8)).toEqual({
      x: 1,
      y: 1,
      width: 2,
      height: 2
    })
  })

  it('pulls a rectangle back inside the image', () => {
    expect(clampCropRect({ x: -4, y: 6, width: 20, height: 20 }, 8, 8)).toEqual({
      x: 0,
      y: 6,
      width: 8,
      height: 2
    })
  })

  it('never collapses to nothing', () => {
    const rect = clampCropRect({ x: 99, y: 99, width: 0, height: 0 }, 8, 8)

    expect(rect.width).toBeGreaterThan(0)
    expect(rect.height).toBeGreaterThan(0)
  })

  it('rounds fractional edges to whole pixels', () => {
    expect(clampCropRect({ x: 1.4, y: 2.6, width: 3.3, height: 3.3 }, 8, 8)).toEqual({
      x: 1,
      y: 3,
      width: 3,
      height: 3
    })
  })
})
