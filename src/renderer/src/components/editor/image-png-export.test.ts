import { describe, expect, it } from 'vitest'
import { imagePngLayout } from './image-png-export'

describe('imagePngLayout', () => {
  it('doubles small images for crisp text', () => {
    expect(imagePngLayout({ width: 300, height: 100 })).toEqual({
      width: 600,
      height: 200,
      pixelRatio: 2
    })
  })

  it('scales down to stay inside the clipboard pixel budget and canvas side limit', () => {
    const budget = imagePngLayout({ width: 4000, height: 4000 }, 1_000_000)
    expect(budget!.width * budget!.height).toBeLessThanOrEqual(1_000_000)
    const wide = imagePngLayout({ width: 40_000, height: 10 })
    expect(wide!.width).toBeLessThanOrEqual(16384)
  })

  it('refuses an image with no size', () => {
    expect(imagePngLayout({ width: 0, height: 10 })).toBeNull()
  })
})
