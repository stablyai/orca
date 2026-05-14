import { describe, expect, it } from 'vitest'
import { keybindingCatalog } from '../../../../shared/keybindings/keybinding-catalog'
import { buildEffectiveKeymap } from '../../../../shared/keybindings/effective-keymap'
import type {
  EffectiveKeymap,
  KeybindingEvent
} from '../../../../shared/keybindings/keybinding-types'
import { resolveAppShellShortcutAction } from './app-shell-shortcut-policy'

function keymap(overrides: Record<string, string | string[] | 'none'> = {}): EffectiveKeymap {
  return buildEffectiveKeymap({
    catalog: keybindingCatalog,
    platform: 'linux',
    overrides
  })
}

function event(input: Partial<KeybindingEvent>): KeybindingEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...input
  }
}

describe('resolveAppShellShortcutAction', () => {
  it('uses the effective keymap for renderer-owned tab shortcuts', () => {
    const map = keymap({ 'terminal.tab.new': 'ctrl+shift+y' })

    expect(
      resolveAppShellShortcutAction(event({ key: 't', code: 'KeyT', ctrlKey: true }), map)
    ).toBeNull()
    expect(
      resolveAppShellShortcutAction(
        event({ key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true }),
        map
      )
    ).toEqual({ type: 'openNewTerminalTab' })
  })

  it('honors explicit unbinding', () => {
    const map = keymap({ 'tab.closeActive': 'none' })

    expect(
      resolveAppShellShortcutAction(event({ key: 'w', code: 'KeyW', ctrlKey: true }), map)
    ).toBeNull()
  })

  it('matches shifted bracket shortcuts by physical code', () => {
    expect(
      resolveAppShellShortcutAction(
        event({ key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true }),
        keymap()
      )
    ).toEqual({ type: 'switchTab', direction: 1 })
  })
})
