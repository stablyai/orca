import { describe, expect, it } from 'vitest'
import { petFloorY, resampleSubject } from './pet-image-resample'
import { BUNDLED_PET_RIGS } from './pet-rigs'
import { DEFAULT_PET_ID, GREMLIN_PET_ID } from './pet-models'
import type { RgbaImage } from './pet-image-cutout'

const SRC_W = 40
const SRC_H = 60

/** Solid red block occupying x 10..29, y 12..47 of the source. */
const BOUNDS = { x0: 10, y0: 12, x1: 29, y1: 47 }

function source(): { image: RgbaImage; mask: Uint8Array } {
  const data = new Uint8ClampedArray(SRC_W * SRC_H * 4)
  const mask = new Uint8Array(SRC_W * SRC_H)
  for (let y = 0; y < SRC_H; y++) {
    for (let x = 0; x < SRC_W; x++) {
      const p = y * SRC_W + x
      const inside = x >= BOUNDS.x0 && x <= BOUNDS.x1 && y >= BOUNDS.y0 && y <= BOUNDS.y1
      mask[p] = inside ? 255 : 0
      data[p * 4] = inside ? 220 : 10
      data[p * 4 + 1] = inside ? 30 : 10
      data[p * 4 + 2] = inside ? 30 : 10
      data[p * 4 + 3] = 255
    }
  }
  return { image: { data, width: SRC_W, height: SRC_H }, mask }
}

const target = { frame: { width: 80, height: 100 }, floorY: 90 }

function opaqueBounds(img: RgbaImage): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = img.width
  let y0 = img.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] < 128) {
        continue
      }
      if (x < x0) {
        x0 = x
      }
      if (x > x1) {
        x1 = x
      }
      if (y < y0) {
        y0 = y
      }
      if (y > y1) {
        y1 = y
      }
    }
  }
  return { x0, y0, x1, y1 }
}

describe('resampleSubject', () => {
  it('produces exactly the target frame', () => {
    const { image, mask } = source()

    const out = resampleSubject(image, mask, BOUNDS, target)

    expect(out.width).toBe(80)
    expect(out.height).toBe(100)
  })

  it('stands the subject on the floor line', () => {
    const { image, mask } = source()

    const out = resampleSubject(image, mask, BOUNDS, target)

    expect(opaqueBounds(out).y1).toBe(target.floorY - 1)
  })

  it('centres the subject horizontally', () => {
    const { image, mask } = source()

    const box = opaqueBounds(resampleSubject(image, mask, BOUNDS, target))
    const leftGap = box.x0
    const rightGap = target.frame.width - 1 - box.x1

    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1)
  })

  it('keeps the aspect ratio of what was uploaded', () => {
    const { image, mask } = source()
    const sourceAspect = (BOUNDS.x1 - BOUNDS.x0 + 1) / (BOUNDS.y1 - BOUNDS.y0 + 1)

    const box = opaqueBounds(resampleSubject(image, mask, BOUNDS, target))
    const outAspect = (box.x1 - box.x0 + 1) / (box.y1 - box.y0 + 1)

    expect(outAspect).toBeCloseTo(sourceAspect, 1)
  })

  it('drops the background rather than carrying it into the frame', () => {
    const { image, mask } = source()

    const out = resampleSubject(image, mask, BOUNDS, target)

    expect(out.data[3]).toBe(0)
  })

  it('keeps a soft cutout edge instead of hardening it to opaque', () => {
    const { image, mask } = source()
    // A feathered left column of the subject: still above the mask threshold,
    // so it is drawn — the alpha is the whole point of a hand-made cutout.
    for (let y = BOUNDS.y0; y <= BOUNDS.y1; y++) {
      image.data[(y * SRC_W + BOUNDS.x0) * 4 + 3] = 160
    }

    const out = resampleSubject(image, mask, BOUNDS, target)
    const box = opaqueBounds(out)
    const alphas = new Set<number>()
    for (let y = box.y0; y <= box.y1; y++) {
      alphas.add(out.data[(y * out.width + box.x0) * 4 + 3])
    }

    expect([...alphas]).toEqual([160])
  })

  it('never lets the subject grow past the headroom above the floor', () => {
    const { image, mask } = source()
    // A floor near the top leaves almost no room; the subject must shrink.
    const shallow = { frame: { width: 80, height: 100 }, floorY: 20 }

    const box = opaqueBounds(resampleSubject(image, mask, BOUNDS, shallow))

    expect(box.y0).toBeGreaterThanOrEqual(0)
    expect(box.y1).toBe(19)
  })
})

describe('petFloorY', () => {
  it('puts the floor at the bottom of the legs', () => {
    expect(petFloorY(BUNDLED_PET_RIGS[GREMLIN_PET_ID])).toBe(300)
    expect(petFloorY(BUNDLED_PET_RIGS[DEFAULT_PET_ID])).toBe(180)
  })
})
