import { describe, expect, it } from 'vitest'
import { resolveEffectiveTerminalBackgroundOpacity } from './terminal-appearance'

describe('resolveEffectiveTerminalBackgroundOpacity', () => {
  it('keeps terminal backgrounds opaque by default under glass', () => {
    expect(
      resolveEffectiveTerminalBackgroundOpacity({
        glassEffect: true,
        terminalBackgroundOpacity: undefined
      })
    ).toBe(undefined)
  })

  it('honors explicit terminal transparency', () => {
    expect(resolveEffectiveTerminalBackgroundOpacity({ terminalBackgroundOpacity: 0.35 })).toBe(
      0.35
    )
  })
})
