// Window shortcuts must resolve letters through the active keyboard layout, including the
// macOS Option-composed path where the event carries no Latin logical key.
import { describe, expect, it } from 'vitest'
import {
  resolveWindowShortcutAction,
  type WindowShortcutAction,
  type WindowShortcutInput
} from './window-shortcut-policy'

describe('resolveWindowShortcutAction layout resolution', () => {
  it('resolves the floating terminal chord when macOS Option composes the letter', () => {
    expect(
      resolveWindowShortcutAction(
        {
          code: 'KeyA',
          key: 'å',
          meta: true,
          control: false,
          alt: true,
          shift: false
        },
        'darwin'
      )
    ).toEqual({ type: 'toggleFloatingTerminal' })
  })

  it('resolves the floating terminal chord through the layout map, not the physical code', () => {
    // AZERTY types 'a' on physical KeyQ, so only the layout lookup can resolve this chord.
    expect(
      resolveWindowShortcutAction(
        {
          code: 'KeyQ',
          key: 'æ',
          meta: true,
          control: false,
          alt: true,
          shift: false
        },
        'darwin',
        undefined,
        { layoutCharacterForCode: (code) => (code === 'KeyQ' ? 'a' : undefined) }
      )
    ).toEqual({ type: 'toggleFloatingTerminal' })
  })

  it('does not resolve the floating terminal chord from physical KeyA when the layout types another letter', () => {
    expect(
      resolveWindowShortcutAction(
        {
          code: 'KeyA',
          key: 'å',
          meta: true,
          control: false,
          alt: true,
          shift: false
        },
        'darwin',
        undefined,
        { layoutCharacterForCode: (code) => (code === 'KeyA' ? 'q' : undefined) }
      )
    ).toBeNull()
  })

  it('resolves letter shortcuts by layout-aware key, with code as fallback', () => {
    // Why: non-QWERTY layouts (Dvorak, Colemak, AZERTY, …) move letters to
    // other physical keys. Matching only on `input.code` (always QWERTY)
    // breaks the shortcut for those users. Prefer `input.key` when it is a
    // letter; fall back to `input.code` only when `key` is empty or a
    // non-letter marker (dead keys, IME edge cases).

    // Dvorak layout: the letters the user presses sit on different codes
    // ('b'→KeyN, 'l'→KeyP, 'p'→KeyR, 'n'→KeyL, 'j'→KeyC). All must resolve
    // to the layout-matched shortcut.
    const dvorak: [WindowShortcutInput, WindowShortcutAction][] = [
      [
        { code: 'KeyN', key: 'b', meta: true, alt: false, shift: false },
        { type: 'toggleLeftSidebar' }
      ],
      [
        { code: 'KeyP', key: 'l', meta: true, alt: false, shift: false },
        { type: 'toggleRightSidebar' }
      ],
      [{ code: 'KeyR', key: 'p', meta: true, alt: false, shift: false }, { type: 'openQuickOpen' }],
      [
        { code: 'KeyL', key: 'n', meta: true, alt: false, shift: false },
        { type: 'openNewWorkspace' }
      ],
      [
        { code: 'KeyC', key: 'j', meta: true, alt: false, shift: false },
        { type: 'toggleWorktreePalette' }
      ]
    ]
    for (const [input, expected] of dvorak) {
      expect(resolveWindowShortcutAction(input, 'darwin')).toEqual(expected)
    }

    // Inverse guard: physical QWERTY-B on Dvorak types 'x' — that is the
    // platform Cut shortcut, not the sidebar. The layout-aware match must
    // reject it.
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyB', key: 'x', meta: true, alt: false, shift: false },
        'darwin'
      )
    ).toBeNull()

    // Fallback: drivers/IME states that leave `key` empty or non-letter
    // (dead keys, modifier names) must still reach the shortcut on QWERTY.
    const fallbacks: [WindowShortcutInput, WindowShortcutAction][] = [
      [
        { code: 'KeyB', key: '', meta: true, alt: false, shift: false },
        { type: 'toggleLeftSidebar' }
      ],
      [
        { code: 'KeyN', key: 'Dead', meta: true, alt: false, shift: false },
        { type: 'openNewWorkspace' }
      ],
      [{ code: 'KeyP', meta: true, alt: false, shift: false }, { type: 'openQuickOpen' }]
    ]
    for (const [input, expected] of fallbacks) {
      expect(resolveWindowShortcutAction(input, 'darwin')).toEqual(expected)
    }
  })
})
