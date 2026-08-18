import { describe, expect, it } from 'vitest'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'

function event(
  partial: Partial<TerminalShortcutEvent> & Pick<TerminalShortcutEvent, 'key'>
): TerminalShortcutEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...partial
  }
}

describe('terminal-shortcut-yield-app-keybindings', () => {
  it('yields Cmd+←/→ on macOS when customized as an active application keybinding', () => {
    const customKeybindings = {
      'tab.previousSameType': ['Mod+ArrowLeft'],
      'tab.nextSameType': ['Mod+ArrowRight']
    }

    // Orca-first (default): yields to custom tab keybinding
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true }),
        true,
        'false',
        0,
        false,
        customKeybindings,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'orca-first'
      )
    ).toBeNull()

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true }),
        true,
        'false',
        0,
        false,
        customKeybindings,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'orca-first'
      )
    ).toBeNull()

    // Terminal-first: retains terminal readline translation
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true }),
        true,
        'false',
        0,
        false,
        customKeybindings,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'terminal-first'
      )
    ).toEqual({ type: 'sendInput', data: '\x01' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true }),
        true,
        'false',
        0,
        false,
        customKeybindings,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'terminal-first'
      )
    ).toEqual({ type: 'sendInput', data: '\x05' })
  })

  it('yields customized global shortcuts on Windows/Linux', () => {
    const customKeybindings = {
      'tab.previousAllTypes': ['Alt+ArrowLeft'],
      'tab.nextAllTypes': ['Alt+ArrowRight']
    }

    // Orca-first: yields to custom tab keybinding on Linux
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }),
        false,
        'false',
        0,
        false,
        customKeybindings,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'orca-first'
      )
    ).toBeNull()

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }),
        false,
        'false',
        0,
        false,
        customKeybindings,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'orca-first'
      )
    ).toBeNull()
  })
})
