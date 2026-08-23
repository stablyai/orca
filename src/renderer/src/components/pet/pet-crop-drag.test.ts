import { describe, expect, it } from 'vitest'
import { rectFromDrag } from './pet-crop-drag'

const display = { width: 100, height: 100 }
const image = { width: 200, height: 200 }

describe('rectFromDrag', () => {
  it('maps a drag on the preview onto source pixels', () => {
    expect(rectFromDrag({ x: 10, y: 10 }, { x: 50, y: 40 }, display, image)).toEqual({
      x: 20,
      y: 20,
      width: 80,
      height: 60
    })
  })

  it('reads the same rectangle when dragged backwards', () => {
    const forward = rectFromDrag({ x: 10, y: 10 }, { x: 50, y: 40 }, display, image)

    expect(rectFromDrag({ x: 50, y: 40 }, { x: 10, y: 10 }, display, image)).toEqual(forward)
  })

  it('keeps a drag that leaves the preview inside the image', () => {
    const rect = rectFromDrag({ x: 50, y: 50 }, { x: 400, y: -80 }, display, image)

    expect(rect.x + rect.width).toBeLessThanOrEqual(image.width)
    expect(rect.y).toBeGreaterThanOrEqual(0)
  })

  it('never returns an empty rectangle from a stray click', () => {
    const rect = rectFromDrag({ x: 30, y: 30 }, { x: 30, y: 30 }, display, image)

    expect(rect.width).toBeGreaterThan(0)
    expect(rect.height).toBeGreaterThan(0)
  })

  it('treats a display of zero size as no drag at all', () => {
    const rect = rectFromDrag({ x: 0, y: 0 }, { x: 10, y: 10 }, { width: 0, height: 0 }, image)

    expect(rect).toEqual({ x: 0, y: 0, width: image.width, height: image.height })
  })
})
