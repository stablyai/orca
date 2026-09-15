import { describe, it, expect } from 'vitest'
import { classifyInputSourceId } from './input-source-id'

describe('classifyInputSourceId', () => {
  it('returns "unknown" for nullish input so the caller falls back to the fingerprint', () => {
    expect(classifyInputSourceId(null)).toBe('unknown')
    expect(classifyInputSourceId(undefined)).toBe('unknown')
    expect(classifyInputSourceId('')).toBe('unknown')
  })

  it('allowlists plain US Standard as meta', () => {
    expect(classifyInputSourceId('com.apple.keylayout.US')).toBe('meta')
  })

  it('classifies US International PC as compose (Option+C → ç repro)', () => {
    // The International variant is picked precisely to type accented
    // characters, and its Option layer composes them: Option+C → ç,
    // Option+Shift+C → Ç, Option+A → å, Option+E → dead acute.
    expect(classifyInputSourceId('com.apple.keylayout.USInternational-PC')).toBe('compose')
  })

  it('is case-insensitive on the allowlist (defaults differ between macOS versions)', () => {
    expect(classifyInputSourceId('COM.APPLE.KEYLAYOUT.US')).toBe('meta')
    expect(classifyInputSourceId('com.apple.keylayout.us')).toBe('meta')
  })

  it('classifies ABC as compose (the user-reported Option+A → å repro)', () => {
    // ABC looks US on the base layer but composes Option+A → å. Pre-fix,
    // the fingerprint alone drove the decision and flipped
    // macOptionIsMeta=true, silently swallowing the composition.
    expect(classifyInputSourceId('com.apple.keylayout.ABC')).toBe('compose')
  })

  it('classifies Polish Pro as compose (#1205)', () => {
    expect(classifyInputSourceId('com.apple.keylayout.PolishPro')).toBe('compose')
  })

  it('classifies US Extended and ABC Extended as compose', () => {
    expect(classifyInputSourceId('com.apple.keylayout.USExtended')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.ABCExtended')).toBe('compose')
  })

  it('classifies every other Apple-shipped layout as compose (default-deny)', () => {
    // Only plain US is allowlisted; everything else (Dvorak, Colemak,
    // German, French, Turkish, Spanish, Swedish, every CJK Roman IME)
    // falls back to compose.
    expect(classifyInputSourceId('com.apple.keylayout.Dvorak')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.Colemak')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.German')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.French')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.Turkish-QWERTY')).toBe('compose')
    expect(classifyInputSourceId('com.apple.inputmethod.Kotoeri.Roman')).toBe('compose')
    expect(classifyInputSourceId('com.apple.inputmethod.TCIM.Pinyin')).toBe('compose')
    expect(classifyInputSourceId('com.apple.inputmethod.Korean.2SetKorean')).toBe('compose')
  })

  it('does not prefix-leak the US allowlist into extended variants', () => {
    // `com.apple.keylayout.US` must not silently allowlist `USExtended`.
    // The matcher is full-ID equality (case-insensitive), not prefix.
    expect(classifyInputSourceId('com.apple.keylayout.USExtended')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.US.variant')).toBe('compose')
  })
})
