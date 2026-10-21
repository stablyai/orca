import { describe, expect, it } from 'vitest'
import { normalizeStatusBarUsageMode } from './status-bar-usage-mode'

describe('normalizeStatusBarUsageMode', () => {
  it.each([undefined, null, '', 'expanded', 0, false, {}])(
    'defaults missing or invalid value %j to compact',
    (value) => {
      expect(normalizeStatusBarUsageMode(value)).toBe('compact')
    }
  )

  it('preserves supported modes', () => {
    expect(normalizeStatusBarUsageMode('verbose')).toBe('verbose')
    expect(normalizeStatusBarUsageMode('compact')).toBe('compact')
  })
})
