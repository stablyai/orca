import { describe, expect, it } from 'vitest'
import {
  getEffectiveKeybindingsForAction,
  type KeybindingOverrides
} from '../../../../shared/keybindings'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'

const overrides: KeybindingOverrides = {
  'terminal.focusNextPaneAcrossTabs': ['Mod+Shift+ArrowRight', 'Mod+Alt+ArrowRight'],
  'terminal.focusPreviousPaneAcrossTabs': ['Mod+Shift+ArrowLeft', 'Mod+Alt+ArrowLeft']
}

describe('cross-tab terminal pane shortcuts', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('ships unbound on %s', (platform) => {
    expect(getEffectiveKeybindingsForAction('terminal.focusNextPaneAcrossTabs', platform)).toEqual(
      []
    )
    expect(
      getEffectiveKeybindingsForAction('terminal.focusPreviousPaneAcrossTabs', platform)
    ).toEqual([])
  })

  it.each(['darwin', 'linux', 'win32'] as const)('uses the platform modifier on %s', (platform) => {
    const isMac = platform === 'darwin'
    for (const alternate of [false, true]) {
      for (const [key, direction] of [
        ['ArrowRight', 'next'],
        ['ArrowLeft', 'previous']
      ] as const) {
        const input = {
          key,
          code: key,
          metaKey: isMac,
          ctrlKey: !isMac,
          altKey: alternate,
          shiftKey: !alternate
        }
        expect(
          resolveTerminalShortcutAction(input, isMac, 'false', 0, platform === 'win32', overrides)
        ).toEqual({ type: 'focusPaneAcrossTabs', direction })
        expect(
          resolveTerminalShortcutAction(
            { ...input, repeat: true },
            isMac,
            'false',
            0,
            platform === 'win32',
            overrides
          )
        ).not.toEqual({ type: 'focusPaneAcrossTabs', direction })
      }
    }
  })

  it('keeps the existing in-tab pane actions', () => {
    expect(
      resolveTerminalShortcutAction(
        {
          key: ']',
          code: 'BracketRight',
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false
        },
        true
      )
    ).toEqual({ type: 'focusPane', direction: 'next' })
  })
})
