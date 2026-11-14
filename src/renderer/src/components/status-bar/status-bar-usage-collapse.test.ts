import { describe, expect, it } from 'vitest'
import { resolveUsageChipWidth, type UsageChipWidthMemo } from './status-bar-usage-collapse'

describe('resolveUsageChipWidth', () => {
  it('reports the remembered in-row width while a chip is collapsed', () => {
    const memo = new Map<string, UsageChipWidthMemo>()
    expect(resolveUsageChipWidth(memo, 'claude', 40, false)).toBe(40)
    expect(resolveUsageChipWidth(memo, 'claude', 42.5, true)).toBe(40)
    expect(resolveUsageChipWidth(memo, 'claude', 42.5, true)).toBe(40)
  })

  it('uses the out-of-flow width once a collapsed chip changes size', () => {
    const memo = new Map<string, UsageChipWidthMemo>()
    resolveUsageChipWidth(memo, 'claude', 40, false)
    resolveUsageChipWidth(memo, 'claude', 42, true)
    expect(resolveUsageChipWidth(memo, 'claude', 55, true)).toBe(55)
    expect(resolveUsageChipWidth(memo, 'claude', 55, true)).toBe(55)
  })

  it('falls back to the measured width for a chip never seen in the row', () => {
    expect(resolveUsageChipWidth(new Map(), 'claude', 42, true)).toBe(42)
  })
})
