import { describe, expect, it } from 'vitest'
import { parseCanonicalChord } from './chord-parser'
import { formatCanonicalChordLabel, getPrimaryChordLabel } from './keybinding-display'
import { keybindingCatalog } from './keybinding-catalog'
import { buildEffectiveKeymap } from './effective-keymap'

describe('formatCanonicalChordLabel', () => {
  it('formats concrete platform labels for display', () => {
    expect(formatCanonicalChordLabel(parseCanonicalChord('cmd+shift+j'), 'macos')).toBe(
      'Cmd+Shift+J'
    )
    expect(formatCanonicalChordLabel(parseCanonicalChord('ctrl+shift+j'), 'linux')).toBe(
      'Ctrl+Shift+J'
    )
  })
})

describe('getPrimaryChordLabel', () => {
  it('returns overridden and unbound labels from the Effective Keymap', () => {
    const keymap = buildEffectiveKeymap({
      catalog: keybindingCatalog,
      platform: 'linux',
      overrides: {
        'sidebar.right.toggle': 'ctrl+shift+l',
        'sidebar.left.toggle': 'none'
      }
    })

    expect(getPrimaryChordLabel(keymap, 'sidebar.right.toggle')).toBe('Ctrl+Shift+L')
    expect(getPrimaryChordLabel(keymap, 'sidebar.left.toggle')).toBe('Unbound')
  })
})
