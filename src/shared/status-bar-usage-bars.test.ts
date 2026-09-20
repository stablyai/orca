import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STATUS_BAR_USAGE_BARS_VISIBLE,
  normalizeStatusBarUsageBarsVisible
} from './status-bar-usage-bars'

describe('normalizeStatusBarUsageBarsVisible', () => {
  it('passes booleans through', () => {
    expect(normalizeStatusBarUsageBarsVisible(true)).toBe(true)
    expect(normalizeStatusBarUsageBarsVisible(false)).toBe(false)
  })

  it('defaults to visible for anything unset or malformed', () => {
    // Why: the bar is what the status bar has always drawn. An absent or
    // corrupt value must not silently restyle an existing layout on upgrade.
    expect(DEFAULT_STATUS_BAR_USAGE_BARS_VISIBLE).toBe(true)
    for (const value of [undefined, null, 'true', 'false', 0, 1, {}, []]) {
      expect(normalizeStatusBarUsageBarsVisible(value)).toBe(true)
    }
  })
})
