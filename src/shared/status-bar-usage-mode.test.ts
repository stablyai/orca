import { describe, expect, it } from 'vitest'
import { normalizeStatusBarUsageMode } from './status-bar-usage-mode'

describe('normalizeStatusBarUsageMode', () => {
  it('defaults missing and invalid values to verbose', () => {
    expect(normalizeStatusBarUsageMode(undefined)).toBe('verbose')
    expect(normalizeStatusBarUsageMode('expanded')).toBe('verbose')
  })

  it('preserves supported modes', () => {
    expect(normalizeStatusBarUsageMode('verbose')).toBe('verbose')
    expect(normalizeStatusBarUsageMode('compact')).toBe('compact')
  })
})
