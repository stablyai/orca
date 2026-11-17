import { describe, expect, it } from 'vitest'
import { countFittingLabels } from './count-fitting-labels'

describe('countFittingLabels', () => {
  it('shows every label when they all fit, without reserving the chip', () => {
    expect(countFittingLabels([40, 40, 40], 128)).toBe(3)
  })

  it('stops early enough to leave room for the +N chip', () => {
    // 40 + 4 + 40 = 84 fits alone, but not with the 32px chip reserve after it (116 > 100).
    expect(countFittingLabels([40, 40, 40], 100)).toBe(1)
  })

  it('keeps one label when even the first does not fit', () => {
    expect(countFittingLabels([200, 40], 100)).toBe(1)
  })
})
