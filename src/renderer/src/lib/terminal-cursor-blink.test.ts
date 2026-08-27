import { describe, expect, it, vi } from 'vitest'
import { readPrefersReducedMotion, resolveTerminalCursorBlink } from './terminal-cursor-blink'

describe('resolveTerminalCursorBlink', () => {
  it('defaults to blinking when the setting is unset', () => {
    expect(resolveTerminalCursorBlink({})).toBe(true)
    expect(resolveTerminalCursorBlink({ settingEnabled: undefined })).toBe(true)
  })

  it('honors an explicit setting when motion is allowed', () => {
    expect(resolveTerminalCursorBlink({ settingEnabled: true })).toBe(true)
    expect(resolveTerminalCursorBlink({ settingEnabled: false })).toBe(false)
  })

  it('disables blink under prefers-reduced-motion even when the setting is on', () => {
    expect(resolveTerminalCursorBlink({ settingEnabled: true, prefersReducedMotion: true })).toBe(
      false
    )
  })
})

describe('readPrefersReducedMotion', () => {
  it('returns false when matchMedia is unavailable', () => {
    expect(readPrefersReducedMotion(undefined)).toBe(false)
  })

  it('reads the reduce media query', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true })
    expect(readPrefersReducedMotion(matchMedia)).toBe(true)
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
  })
})
