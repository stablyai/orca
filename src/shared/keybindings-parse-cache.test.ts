import { describe, expect, it } from 'vitest'
import { normalizeKeyToken, parseKeybinding } from './keybindings/parser'

describe('parseKeybinding memoization', () => {
  it('never hands out an entry a caller can corrupt', () => {
    const parsed = parseKeybinding('Mod+P')
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(parseKeybinding('Mod+P')?.key).toBe('P')
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
