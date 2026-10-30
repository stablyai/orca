import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeLineStats } from './diff-line-stats'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('computeLineStats', () => {
  it('keeps the existing large modified-file guard before building multisets', () => {
    const split = vi.spyOn(String.prototype, 'split')

    expect(computeLineStats('x'.repeat(250_001), 'y'.repeat(250_000), 'modified')).toBeNull()

    expect(split).not.toHaveBeenCalled()
  })
})
