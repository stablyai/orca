import { describe, expect, it } from 'vitest'
import { markupCanvasSize } from './markup-screenshot-compose'

describe('markupCanvasSize', () => {
  it('keeps the composite within the pixel budget (never over)', () => {
    // A large HiDPI pane: 4000×3000 CSS × dpr 2 = 48M px > the ~33.55M (32×1024×1024) ceiling.
    const maxPixels = 32 * 1024 * 1024
    const size = markupCanvasSize(4000, 3000, 2, maxPixels)
    expect(size.width * size.height).toBeLessThanOrEqual(maxPixels)
    expect(size.width / size.height).toBeCloseTo(4000 / 3000, 3)
  })
})
