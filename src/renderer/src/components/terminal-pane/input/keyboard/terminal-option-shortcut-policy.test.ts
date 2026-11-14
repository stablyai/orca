import { describe, expect, it } from 'vitest'
import { resolveTerminalOptionShortcutAction } from './terminal-option-shortcut-policy'

describe('resolveTerminalOptionShortcutAction', () => {
  it('types non-US Option characters on B/F/D instead of readline word motion (#32100)', () => {
    for (const [key, code] of [
      ['[', 'KeyF'],
      ['{', 'KeyB'],
      ['“', 'KeyD']
    ] as const) {
      expect(
        resolveTerminalOptionShortcutAction(
          { key, code, metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
          {
            isMac: true,
            macOptionAsAlt: 'false',
            optionKeyLocations: 1,
            getKittyKeyboardFlags: () => 0
          }
        )
      ).toBeNull()
    }
  })

  it('preserves readline word motion for US Option glyphs on B/F/D', () => {
    for (const [key, code, expected] of [
      ['∫', 'KeyB', '\x1bb'],
      ['ƒ', 'KeyF', '\x1bf'],
      ['∂', 'KeyD', '\x1bd']
    ] as const) {
      expect(
        resolveTerminalOptionShortcutAction(
          { key, code, metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
          {
            isMac: true,
            macOptionAsAlt: 'false',
            optionKeyLocations: 1,
            getKittyKeyboardFlags: () => 0
          }
        )
      ).toEqual({ type: 'sendInput', data: expected })
    }
  })
})
