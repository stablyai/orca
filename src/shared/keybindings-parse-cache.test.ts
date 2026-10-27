import { describe, expect, it } from 'vitest'
import { normalizeKeyToken, parseKeybinding } from './keybindings/parser'

describe('parseKeybinding memoization', () => {
  it('reuses the parsed result for a repeated binding string', () => {
    const first = parseKeybinding('Mod+Shift+K')
    const second = parseKeybinding('Mod+Shift+K')
    expect(first).not.toBeNull()
    expect(second).toBe(first)
  })

  it('never hands out an entry a caller can corrupt', () => {
    const parsed = parseKeybinding('Mod+P')
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(parseKeybinding('Mod+P')?.key).toBe('P')
  })

  it('evicts cached entries after many distinct strings and still parses correctly', () => {
    const before = parseKeybinding('Mod+Shift+K')
    expect(before?.key).toBe('K')
    for (let index = 0; index < 600; index += 1) {
      expect(parseKeybinding(`invalid-cache-entry-${index}`)).toBeNull()
    }
    const after = parseKeybinding('Mod+Shift+K')
    expect(after).not.toBe(before)
    expect(after).toEqual(before)
    expect(parseKeybinding('DoubleTap+Ctrl')?.doubleTapModifier).toBe('Ctrl')
  })

  it('maps token spellings through the table and blocks prototype keys', () => {
    expect(normalizeKeyToken(' ')).toBe('Space')
    expect(normalizeKeyToken('pgdn')).toBe('PageDown')
    expect(normalizeKeyToken('subtract')).toBe('NumpadSubtract')
    expect(normalizeKeyToken('nonsense')).toBe(null)
    expect(normalizeKeyToken('')).toBe(null)
    // Object.prototype keys must not leak through the token table.
    expect(normalizeKeyToken('constructor')).toBe(null)
    expect(normalizeKeyToken('__proto__')).toBe(null)
  })
})
