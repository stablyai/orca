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

  it('stays bounded and correct when fed far more strings than the cache holds', () => {
    for (let index = 0; index < 2000; index++) {
      expect(parseKeybinding(`Mod+Alt+F${(index % 24) + 1}`)?.key).toBe(`F${(index % 24) + 1}`)
    }
    // A cleared cache must still return the right answer, not a stale neighbour.
    expect(parseKeybinding('Mod+Shift+K')?.key).toBe('K')
    expect(parseKeybinding('DoubleTap+Shift')?.doubleTapModifier).toBe('Shift')
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
