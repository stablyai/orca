import { describe, expect, it } from 'vitest'
import { formatSparsePresetUpdatedAt } from './sparse-preset-date'

describe('formatSparsePresetUpdatedAt', () => {
  it('formats valid timestamps', () => {
    expect(formatSparsePresetUpdatedAt(Date.UTC(2026, 0, 2))).toContain('2026')
  })

  it('returns null for invalid persisted timestamps', () => {
    expect(formatSparsePresetUpdatedAt(Number.NaN)).toBeNull()
    expect(formatSparsePresetUpdatedAt(Number.POSITIVE_INFINITY)).toBeNull()
  })
})
