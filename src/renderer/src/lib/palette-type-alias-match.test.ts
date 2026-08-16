import { describe, expect, it } from 'vitest'
import { selectPaletteTypeAliasMatch } from './palette-type-alias-match'

const ALIASES = ['mobile emulator tab', 'mobile emulator', 'ios simulator', 'emulator'] as const

describe('selectPaletteTypeAliasMatch', () => {
  it('prefers the alias with the earliest match, not declaration order', () => {
    expect(selectPaletteTypeAliasMatch(ALIASES, 'emulator')).toEqual({
      text: 'emulator',
      range: { start: 0, end: 8 }
    })
  })

  it('keeps the first alias when several match at the same offset', () => {
    expect(selectPaletteTypeAliasMatch(ALIASES, 'mobile')).toEqual({
      text: 'mobile emulator tab',
      range: { start: 0, end: 6 }
    })
  })

  it('still reports a mid-string hit when no alias starts with the query', () => {
    expect(selectPaletteTypeAliasMatch(ALIASES, 'simulator')).toEqual({
      text: 'ios simulator',
      range: { start: 4, end: 13 }
    })
  })

  it('returns null for an empty query or no match', () => {
    expect(selectPaletteTypeAliasMatch(ALIASES, '')).toBeNull()
    expect(selectPaletteTypeAliasMatch(ALIASES, 'browser')).toBeNull()
    expect(selectPaletteTypeAliasMatch([], 'emulator')).toBeNull()
  })
})
