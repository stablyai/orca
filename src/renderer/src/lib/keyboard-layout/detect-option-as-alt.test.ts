import { describe, it, expect } from 'vitest'
import {
  detectOptionAsAltFromLayoutMap,
  detectedCategoryToDefault,
  effectiveMacOptionAsAlt,
  type LayoutMapLike
} from './detect-option-as-alt'

function mapOf(entries: Record<string, string>): LayoutMapLike {
  const m = new Map(Object.entries(entries))
  return { get: (code) => m.get(code), size: m.size }
}

const US: Record<string, string> = {
  KeyQ: 'q',
  KeyW: 'w',
  KeyA: 'a',
  KeyZ: 'z',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']'
}

describe('detectOptionAsAltFromLayoutMap', () => {
  it('classifies US Standard as us', () => {
    expect(detectOptionAsAltFromLayoutMap(mapOf(US))).toBe('us')
  })

  it('classifies US International as us (same fingerprint, dead keys only)', () => {
    // US-International keeps all unshifted ASCII letters and punctuation.
    // Only Option-layer composition differs — invisible to getLayoutMap().
    expect(detectOptionAsAltFromLayoutMap(mapOf(US))).toBe('us')
  })

  it('classifies UK as non-us (Backquote → §)', () => {
    expect(detectOptionAsAltFromLayoutMap(mapOf({ ...US, Backquote: '§' }))).toBe('non-us')
  })

  it('classifies German QWERTZ as non-us (KeyZ → y, Semicolon → ö)', () => {
    expect(
      detectOptionAsAltFromLayoutMap(
        mapOf({
          ...US,
          KeyZ: 'y',
          Semicolon: 'ö',
          Quote: 'ä',
          Backquote: '^',
          BracketLeft: 'ü',
          BracketRight: '+'
        })
      )
    ).toBe('non-us')
  })

  it('classifies Turkish Q as non-us (the #903 repro)', () => {
    expect(
      detectOptionAsAltFromLayoutMap(
        mapOf({
          ...US,
          Semicolon: 'ş',
          Quote: 'i',
          Backquote: '"',
          BracketLeft: 'ğ',
          BracketRight: 'ü'
        })
      )
    ).toBe('non-us')
  })

  it('classifies Turkish F as non-us (KeyQ → f, every letter swapped)', () => {
    expect(
      detectOptionAsAltFromLayoutMap(
        mapOf({
          KeyQ: 'f',
          KeyW: 'g',
          KeyA: 'u',
          KeyZ: 'j',
          Semicolon: 's',
          Quote: 'y',
          Backquote: '+',
          BracketLeft: 'ğ',
          BracketRight: 'ü'
        })
      )
    ).toBe('non-us')
  })

  it('classifies French AZERTY as non-us (KeyQ → a)', () => {
    expect(
      detectOptionAsAltFromLayoutMap(
        mapOf({
          KeyQ: 'a',
          KeyW: 'z',
          KeyA: 'q',
          KeyZ: 'w',
          Semicolon: 'm',
          Quote: 'ù',
          Backquote: '@',
          BracketLeft: ')',
          BracketRight: '='
        })
      )
    ).toBe('non-us')
  })

  it('classifies Spanish ISO as non-us (Semicolon → ñ)', () => {
    expect(
      detectOptionAsAltFromLayoutMap(mapOf({ ...US, Semicolon: 'ñ', Quote: '´', Backquote: 'º' }))
    ).toBe('non-us')
  })

  it('classifies Swedish as non-us (BracketLeft → å)', () => {
    expect(
      detectOptionAsAltFromLayoutMap(
        mapOf({
          ...US,
          Semicolon: 'ö',
          Quote: 'ä',
          Backquote: '§',
          BracketLeft: 'å',
          BracketRight: '¨'
        })
      )
    ).toBe('non-us')
  })

  it('classifies Dvorak as non-us (KeyQ → apostrophe)', () => {
    expect(
      detectOptionAsAltFromLayoutMap(
        mapOf({
          KeyQ: "'",
          KeyW: ',',
          KeyA: 'a',
          KeyZ: ';',
          Semicolon: 's',
          Quote: '-',
          Backquote: '`',
          BracketLeft: '/',
          BracketRight: '='
        })
      )
    ).toBe('non-us')
  })

  it('classifies Colemak as non-us (Semicolon → o)', () => {
    // Colemak is a US-variant but maps Semicolon → o. Matches Ghostty:
    // com.apple.keylayout.Colemak is not whitelisted there either.
    expect(detectOptionAsAltFromLayoutMap(mapOf({ ...US, Semicolon: 'o' }))).toBe('non-us')
  })

  it('returns unknown for null', () => {
    expect(detectOptionAsAltFromLayoutMap(null)).toBe('unknown')
  })

  it('returns unknown for empty map', () => {
    expect(detectOptionAsAltFromLayoutMap(mapOf({}))).toBe('unknown')
  })

  it('returns unknown when fingerprint is incomplete (missing KeyQ)', () => {
    const partial: Record<string, string> = { ...US }
    delete partial.KeyQ
    expect(detectOptionAsAltFromLayoutMap(mapOf(partial))).toBe('unknown')
  })
})

describe('detectedCategoryToDefault', () => {
  it('us → true', () => {
    expect(detectedCategoryToDefault('us')).toBe('true')
  })
  it('non-us → false', () => {
    expect(detectedCategoryToDefault('non-us')).toBe('false')
  })
  it('unknown → false (conservative)', () => {
    expect(detectedCategoryToDefault('unknown')).toBe('false')
  })
})

describe('effectiveMacOptionAsAlt', () => {
  it('auto + us → true', () => {
    expect(effectiveMacOptionAsAlt('auto', 'us')).toBe('true')
  })
  it('auto + non-us → false', () => {
    expect(effectiveMacOptionAsAlt('auto', 'non-us')).toBe('false')
  })
  it('auto + unknown → false', () => {
    expect(effectiveMacOptionAsAlt('auto', 'unknown')).toBe('false')
  })
  it('explicit true wins over detected non-us', () => {
    expect(effectiveMacOptionAsAlt('true', 'non-us')).toBe('true')
  })
  it('explicit false wins over detected us', () => {
    expect(effectiveMacOptionAsAlt('false', 'us')).toBe('false')
  })
  it('explicit left passes through', () => {
    expect(effectiveMacOptionAsAlt('left', 'us')).toBe('left')
  })
  it('explicit right passes through', () => {
    expect(effectiveMacOptionAsAlt('right', 'non-us')).toBe('right')
  })
})
