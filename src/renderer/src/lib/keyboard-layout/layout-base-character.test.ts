import { afterEach, describe, expect, it } from 'vitest'
import {
  _setLayoutMapForTests,
  getLayoutBaseCharacterForCode,
  normalizeLayoutBaseCharacter
} from './layout-base-character'

describe('normalizeLayoutBaseCharacter', () => {
  it('accepts a single printable codepoint, lowercased', () => {
    expect(normalizeLayoutBaseCharacter('p')).toBe('p')
    expect(normalizeLayoutBaseCharacter('P')).toBe('p')
    expect(normalizeLayoutBaseCharacter('ö')).toBe('ö')
    expect(normalizeLayoutBaseCharacter(';')).toBe(';')
  })

  it('rejects empty, named-key, multi-codepoint, and control values', () => {
    expect(normalizeLayoutBaseCharacter(undefined)).toBeUndefined()
    expect(normalizeLayoutBaseCharacter('')).toBeUndefined()
    expect(normalizeLayoutBaseCharacter('Dead')).toBeUndefined()
    expect(normalizeLayoutBaseCharacter('\t')).toBeUndefined()
    expect(normalizeLayoutBaseCharacter(' ')).toBeUndefined()
  })
})

describe('getLayoutBaseCharacterForCode', () => {
  afterEach(() => {
    _setLayoutMapForTests(null)
  })

  it('returns undefined without a cached map, and resolves through one', () => {
    expect(getLayoutBaseCharacterForCode('KeyP')).toBeUndefined()

    const azertyEntries = new Map([
      ['Semicolon', 'm'],
      ['KeyE', 'Dead']
    ])
    _setLayoutMapForTests({
      get: (code) => azertyEntries.get(code),
      size: azertyEntries.size
    })
    expect(getLayoutBaseCharacterForCode('Semicolon')).toBe('m')
    expect(getLayoutBaseCharacterForCode('KeyE')).toBeUndefined()
    expect(getLayoutBaseCharacterForCode('KeyZ')).toBeUndefined()
  })
})
