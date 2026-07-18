import { describe, expect, it } from 'vitest'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'

const shiftEnterEvent: TerminalShortcutEvent = {
  key: 'Enter',
  code: 'Enter',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: true,
  repeat: false
}

describe('Codex Shift+Enter shortcut policy', () => {
  it('uses Ctrl+J for a trusted Codex pane even while Kitty keyboard is active', () => {
    expect(
      resolveTerminalShortcutAction(
        shiftEnterEvent,
        true,
        'false',
        0,
        false,
        undefined,
        undefined,
        () => true,
        undefined,
        undefined,
        undefined,
        () => 'ctrl-j'
      )
    ).toEqual({ type: 'sendInput', data: '\x0a' })
  })

  it('keeps Codex Ctrl+J ahead of client OS, host OS, and Kitty protocol choices', () => {
    for (const [isMac, isWindows, kittyActive, windowsHost] of [
      [true, false, false, false],
      [false, true, false, true],
      [false, false, true, true]
    ] as const) {
      expect(
        resolveTerminalShortcutAction(
          shiftEnterEvent,
          isMac,
          'false',
          0,
          isWindows,
          undefined,
          undefined,
          () => kittyActive,
          undefined,
          () => 'csi-u',
          () => windowsHost,
          () => 'ctrl-j'
        )
      ).toEqual({ type: 'sendInput', data: '\x0a' })
    }
  })
})
