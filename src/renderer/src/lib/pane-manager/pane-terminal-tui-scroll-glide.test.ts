import { describe, expect, it, vi } from 'vitest'
import {
  normalizeTerminalTuiScrollGlideIntensity,
  nudgeTerminalTuiScrollGlide,
  resolveTerminalTuiScrollGlideMaxCellFraction
} from './pane-terminal-tui-scroll-glide'

describe('terminal TUI scroll glide', () => {
  it('defaults unknown intensity to subtle', () => {
    expect(normalizeTerminalTuiScrollGlideIntensity(undefined)).toBe('subtle')
    expect(normalizeTerminalTuiScrollGlideIntensity('nope')).toBe('subtle')
    expect(normalizeTerminalTuiScrollGlideIntensity('off')).toBe('off')
    expect(normalizeTerminalTuiScrollGlideIntensity('medium')).toBe('medium')
  })

  it('maps intensity to max cell fractions', () => {
    expect(resolveTerminalTuiScrollGlideMaxCellFraction('off')).toBe(0)
    expect(resolveTerminalTuiScrollGlideMaxCellFraction('subtle')).toBe(0.35)
    expect(resolveTerminalTuiScrollGlideMaxCellFraction('medium')).toBe(0.65)
    expect(resolveTerminalTuiScrollGlideMaxCellFraction(undefined)).toBe(0.35)
  })

  it('no-ops when intensity is off or delta is zero', () => {
    const nudgeTuiGlide = vi.fn()
    const terminal = { _core: { _viewport: { nudgeTuiGlide } } }
    nudgeTerminalTuiScrollGlide(terminal, 40, 'off')
    nudgeTerminalTuiScrollGlide(terminal, 0, 'subtle')
    expect(nudgeTuiGlide).not.toHaveBeenCalled()
  })

  it('forwards pixel delta and max fraction to the viewport patch', () => {
    const nudgeTuiGlide = vi.fn()
    const terminal = { _core: { _viewport: { nudgeTuiGlide } } }
    nudgeTerminalTuiScrollGlide(terminal, 24, 'medium')
    expect(nudgeTuiGlide).toHaveBeenCalledWith(24, 0.65)
  })

  it('tolerates terminals without the viewport patch', () => {
    expect(() => nudgeTerminalTuiScrollGlide({}, 12, 'subtle')).not.toThrow()
  })
})
