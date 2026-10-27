import { describe, it, expect } from 'vitest'
import {
  detectOptionAsAltFromLayoutMap,
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

  it('returns unknown when fingerprint is incomplete (missing KeyQ)', () => {
    const partial: Record<string, string> = { ...US }
    delete partial.KeyQ
    expect(detectOptionAsAltFromLayoutMap(mapOf(partial))).toBe('unknown')
  })
})

describe('effectiveMacOptionAsAlt', () => {
  it('auto + unknown → false', () => {
    expect(effectiveMacOptionAsAlt('auto', 'unknown')).toBe('false')
  })
})
