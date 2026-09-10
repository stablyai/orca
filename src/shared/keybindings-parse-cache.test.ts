import { describe, expect, it } from 'vitest'
import { KEYBINDING_DEFINITIONS } from './keybindings/definitions'
import { getDefaultBindings } from './keybindings/effective'
import { formatKeybindingList } from './keybindings/formatting'
import { normalizeKeyToken, parseKeybinding } from './keybindings/parser'

describe('parseKeybinding memoization', () => {
  it('reuses the parsed result for a repeated binding string', () => {
    const first = parseKeybinding('Mod+Shift+K')
    const second = parseKeybinding('Mod+Shift+K')
    expect(first).not.toBeNull()
    expect(second).toBe(first)
  })

  it('caches rejections without re-parsing', () => {
    expect(parseKeybinding('K+J')).toBeNull()
    expect(parseKeybinding('K+J')).toBeNull()
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

  it('parses every distinct token form identically across repeat calls', () => {
    const tokens = [
      ' ',
      'a',
      '7',
      'f7',
      '[',
      '}',
      '-',
      '_',
      '=',
      '+',
      ',',
      '.',
      '/',
      '\\',
      ';',
      "'",
      '`',
      'return',
      'esc',
      'spacebar',
      'pgup',
      'pgdn',
      'arrowleft',
      'left',
      'down',
      'backspace',
      'del',
      'ins',
      'numpadadd',
      'subtract',
      'nonsense',
      ''
    ]
    for (const token of tokens) {
      expect(normalizeKeyToken(token)).toBe(normalizeKeyToken(token))
    }
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

describe('shortcut label output', () => {
  it('formats every default binding identically on repeat calls, on both glyph platforms', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      for (const definition of KEYBINDING_DEFINITIONS) {
        const bindings = getDefaultBindings(definition, platform)
        const label = formatKeybindingList(bindings, platform)
        expect(formatKeybindingList(bindings, platform)).toBe(label)
        expect(label.length).toBeGreaterThan(0)
      }
    }
  })
})
