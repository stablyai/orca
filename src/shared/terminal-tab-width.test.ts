import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_TAB_WIDTH,
  normalizeTerminalTabWidth,
  TERMINAL_TAB_WIDTH_VALUES
} from './terminal-tab-width'

describe('normalizeTerminalTabWidth', () => {
  it('passes through every known preset', () => {
    for (const value of TERMINAL_TAB_WIDTH_VALUES) {
      expect(normalizeTerminalTabWidth(value)).toBe(value)
    }
  })

  it('falls back to the default for unknown, legacy, or malformed values', () => {
    for (const value of [undefined, null, '', 'medium', 'HUG', 42, {}]) {
      expect(normalizeTerminalTabWidth(value)).toBe(DEFAULT_TERMINAL_TAB_WIDTH)
    }
  })
})
