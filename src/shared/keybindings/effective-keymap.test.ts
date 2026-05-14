import { describe, expect, it } from 'vitest'
import { keybindingCatalog } from './keybinding-catalog'
import { buildEffectiveKeymap, resolveKeybindingAction } from './effective-keymap'
import type { KeybindingCatalogEntry, KeybindingEvent } from './keybinding-types'

describe('resolveKeybindingAction', () => {
  it('should let a Linux terminal paste override replace the default chord set', () => {
    // Arrange
    const keymap = buildEffectiveKeymap({
      catalog: keybindingCatalog,
      platform: 'linux',
      overrides: {
        'terminal.paste': ['ctrl+shift+v']
      }
    })

    // Act
    const defaultPaste = resolveKeybindingAction(
      keymap,
      event({ key: 'v', code: 'KeyV', ctrlKey: true }),
      'terminal'
    )
    const overriddenPaste = resolveKeybindingAction(
      keymap,
      event({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }),
      'terminal'
    )

    // Assert
    expect(defaultPaste).toBeNull()
    expect(overriddenPaste).toEqual({
      id: 'terminal.paste',
      command: { type: 'terminalPaste' }
    })
  })

  it('should accept Super as a Linux user-facing alias for the meta key', () => {
    // Arrange
    const keymap = buildEffectiveKeymap({
      catalog: keybindingCatalog,
      platform: 'linux',
      overrides: {
        'terminal.paste': 'super+v'
      }
    })

    // Act
    const paste = resolveKeybindingAction(
      keymap,
      event({ key: 'v', code: 'KeyV', metaKey: true }),
      'terminal'
    )

    // Assert
    expect(keymap.diagnostics).toEqual([])
    expect(paste).toEqual({
      id: 'terminal.paste',
      command: { type: 'terminalPaste' }
    })
  })

  it('should keep valid chords when another override entry is invalid', () => {
    // Arrange
    const keymap = buildEffectiveKeymap({
      catalog: keybindingCatalog,
      platform: 'linux',
      overrides: {
        'terminal.paste': ['ctrl+shift+v', 'ctrl+alt'],
        'unknown.action': 'ctrl+x'
      }
    })

    // Act
    const paste = resolveKeybindingAction(
      keymap,
      event({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }),
      'terminal'
    )

    // Assert
    expect(paste?.id).toBe('terminal.paste')
    expect(keymap.diagnostics).toEqual([
      expect.objectContaining({ code: 'unknown-action', actionId: 'unknown.action' }),
      expect.objectContaining({ code: 'invalid-chord', actionId: 'terminal.paste' })
    ])
  })

  it('should treat none as an explicit unbinding without falling back to defaults', () => {
    // Arrange
    const keymap = buildEffectiveKeymap({
      catalog: keybindingCatalog,
      platform: 'macos',
      overrides: {
        'terminal.paste': 'none'
      }
    })

    // Act
    const paste = resolveKeybindingAction(
      keymap,
      event({ key: 'v', code: 'KeyV', metaKey: true }),
      'terminal'
    )

    // Assert
    expect(paste).toBeNull()
    expect(keymap.bindings.find((binding) => binding.id === 'terminal.paste')?.source).toBe(
      'unbound'
    )
  })

  it('should ignore a user override that conflicts on overlapping shortcut surfaces', () => {
    // Arrange
    const catalog: KeybindingCatalogEntry[] = [
      {
        id: 'terminal.paste',
        title: 'Paste into terminal',
        surfaces: ['terminal'],
        defaults: { linux: ['ctrl+v'] },
        command: { type: 'terminalPaste' }
      },
      {
        id: 'quickOpen.open',
        title: 'Open quick open',
        surfaces: ['mainWindow'],
        defaults: { linux: ['ctrl+p'] },
        command: { type: 'openQuickOpen' }
      }
    ]

    // Act
    const keymap = buildEffectiveKeymap({
      catalog,
      platform: 'linux',
      overrides: {
        'quickOpen.open': 'ctrl+v'
      }
    })

    // Assert
    expect(keymap.diagnostics).toEqual([
      expect.objectContaining({
        code: 'conflict',
        actionId: 'quickOpen.open',
        chord: 'ctrl+v'
      })
    ])
    expect(
      resolveKeybindingAction(
        keymap,
        event({ key: 'p', code: 'KeyP', ctrlKey: true }),
        'mainWindow'
      )
    ).toEqual({
      id: 'quickOpen.open',
      command: { type: 'openQuickOpen' }
    })
    expect(
      resolveKeybindingAction(
        keymap,
        event({ key: 'v', code: 'KeyV', ctrlKey: true }),
        'mainWindow'
      )
    ).toBeNull()
  })
})

function event(overrides: Partial<KeybindingEvent>): KeybindingEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}
