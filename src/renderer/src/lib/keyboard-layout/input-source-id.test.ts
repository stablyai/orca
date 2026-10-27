import { describe, it, expect } from 'vitest'
import { classifyInputSourceId } from './input-source-id'

describe('classifyInputSourceId', () => {
  it('returns "unknown" for nullish input so the caller falls back to the fingerprint', () => {
    expect(classifyInputSourceId(null)).toBe('unknown')
    expect(classifyInputSourceId(undefined)).toBe('unknown')
    expect(classifyInputSourceId('')).toBe('unknown')
  })

  it.each(['US', 'ABC'])('allowlists standard %s as meta', (name) => {
    expect(classifyInputSourceId(`com.apple.keylayout.${name}`)).toBe('meta')
  })

  it('classifies US International PC as compose (Option+C → ç repro)', () => {
    expect(classifyInputSourceId('com.apple.keylayout.USInternational-PC')).toBe('compose')
  })

  it('is case-insensitive on the allowlist (defaults differ between macOS versions)', () => {
    expect(classifyInputSourceId('COM.APPLE.KEYLAYOUT.US')).toBe('meta')
    expect(classifyInputSourceId('com.apple.keylayout.us')).toBe('meta')
    expect(classifyInputSourceId('COM.APPLE.KEYLAYOUT.ABC')).toBe('meta')
    expect(classifyInputSourceId('com.apple.keylayout.abc')).toBe('meta')
  })

  it('classifies Polish Pro as compose (#1205)', () => {
    expect(classifyInputSourceId('com.apple.keylayout.PolishPro')).toBe('compose')
  })

  it('classifies US Extended and ABC Extended as compose', () => {
    expect(classifyInputSourceId('com.apple.keylayout.USExtended')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.ABCExtended')).toBe('compose')
  })

  it('classifies every other Apple-shipped layout as compose (default-deny)', () => {
    // Only standard ABC/US are allowlisted; other layouts retain composition.
    expect(classifyInputSourceId('com.apple.keylayout.Dvorak')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.Colemak')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.German')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.French')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.Turkish-QWERTY')).toBe('compose')
    expect(classifyInputSourceId('com.apple.inputmethod.Kotoeri.Roman')).toBe('compose')
    expect(classifyInputSourceId('com.apple.inputmethod.TCIM.Pinyin')).toBe('compose')
    expect(classifyInputSourceId('com.apple.inputmethod.Korean.2SetKorean')).toBe('compose')
  })

  it('does not prefix-leak the standard allowlist into extended or custom variants', () => {
    expect(classifyInputSourceId('com.apple.keylayout.USExtended')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.US.variant')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.ABCExtended')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.ABC.variant')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.ABCInternational')).toBe('compose')
    expect(classifyInputSourceId('org.custom.keylayout.ABC')).toBe('compose')
    expect(classifyInputSourceId('unknown')).toBe('compose')
  })
})
