// voice.control keybinding resolution in the main-process window-shortcut allowlist.
import { describe, expect, it } from 'vitest'
import { getWindowShortcutActionId, resolveWindowShortcutAction } from './window-shortcut-policy'

describe('resolveWindowShortcutAction voice.control', () => {
  it('resolves the voice control toggle on Mod+Shift+V across platforms', () => {
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyV', key: 'v', meta: true, control: false, alt: false, shift: true },
        'darwin'
      )
    ).toEqual({ type: 'voiceControlToggle' })

    expect(
      resolveWindowShortcutAction(
        { code: 'KeyV', key: 'v', meta: false, control: true, alt: false, shift: true },
        'linux'
      )
    ).toEqual({ type: 'voiceControlToggle' })

    expect(
      resolveWindowShortcutAction(
        { code: 'KeyV', key: 'v', meta: false, control: true, alt: false, shift: true },
        'win32'
      )
    ).toEqual({ type: 'voiceControlToggle' })

    // Missing shift is not the control chord.
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyV', key: 'v', meta: true, control: false, alt: false, shift: false },
        'darwin'
      )
    ).toBeNull()
  })

  it('applies custom keybinding overrides to the voice control toggle', () => {
    expect(
      resolveWindowShortcutAction(
        { code: 'KeyV', key: 'v', meta: false, control: true, alt: false, shift: true },
        'linux',
        { 'voice.control': [] }
      )
    ).toBeNull()

    expect(
      resolveWindowShortcutAction(
        { code: 'KeyK', key: 'k', meta: false, control: true, alt: true, shift: false },
        'linux',
        { 'voice.control': ['Mod+Alt+K'] }
      )
    ).toEqual({ type: 'voiceControlToggle' })
  })

  it('maps the voice control toggle back to its action id', () => {
    expect(getWindowShortcutActionId({ type: 'voiceControlToggle' })).toBe('voice.control')
  })
})
