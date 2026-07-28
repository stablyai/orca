import { describe, expect, it } from 'vitest'
import { getTerminalVisibilityEffectPhase } from './terminal-visibility-effect-phase'

describe('terminal visibility effect phase', () => {
  it('runs pre-paint only on macOS', () => {
    expect(getTerminalVisibilityEffectPhase('darwin')).toBe('layout')
    expect(getTerminalVisibilityEffectPhase('win32')).toBe('passive')
    expect(getTerminalVisibilityEffectPhase('linux')).toBe('passive')
  })
})
