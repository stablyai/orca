import { describe, expect, it } from 'vitest'
import { isGlassEffectActive } from './glass-theme'

describe('isGlassEffectActive', () => {
  it('returns true on darwin when glassEffect is true', () => {
    expect(isGlassEffectActive({ glassEffect: true }, { isDarwin: true })).toBe(true)
  })

  it('returns false on darwin when glassEffect is false', () => {
    expect(isGlassEffectActive({ glassEffect: false }, { isDarwin: true })).toBe(false)
  })

  it('returns false on non-darwin even when glassEffect is true', () => {
    // Why: vibrancy + transparent windows are macOS-only at the Electron
    // layer. Non-darwin hosts cannot render glass — pretending otherwise
    // would yield broken low-alpha UI without an OS-level backdrop.
    expect(isGlassEffectActive({ glassEffect: true }, { isDarwin: false })).toBe(false)
  })

  it('returns false for null / undefined settings', () => {
    expect(isGlassEffectActive(null, { isDarwin: true })).toBe(false)
    expect(isGlassEffectActive(undefined, { isDarwin: true })).toBe(false)
  })

  it('falls back to process.platform when isDarwin is not provided', () => {
    // process.platform in the test environment is whatever the host runs.
    // We just verify the function does not throw and returns a boolean.
    const result = isGlassEffectActive({ glassEffect: true })
    expect(typeof result).toBe('boolean')
  })
})
