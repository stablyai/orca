import { describe, expect, it } from 'vitest'
import { heldIndexShortcutActions } from './index-shortcut-hints'

const none = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }

describe('heldIndexShortcutActions', () => {
  it('follows the default digit chords', () => {
    expect(heldIndexShortcutActions({ ...none, ctrlKey: true }, 'linux', undefined)).toEqual({
      'workspace.selectByIndex': true,
      'tab.selectByIndex': false
    })
    expect(heldIndexShortcutActions({ ...none, altKey: true }, 'linux', undefined)).toEqual({
      'workspace.selectByIndex': false,
      'tab.selectByIndex': true
    })
  })

  it('follows a rebound modifier instead of Cmd or Ctrl', () => {
    const keybindings = { 'workspace.selectByIndex': ['Alt+Shift+1'] }
    expect(
      heldIndexShortcutActions({ ...none, ctrlKey: true }, 'linux', keybindings)[
        'workspace.selectByIndex'
      ]
    ).toBe(false)
    expect(
      heldIndexShortcutActions({ ...none, altKey: true, shiftKey: true }, 'linux', keybindings)[
        'workspace.selectByIndex'
      ]
    ).toBe(true)
  })
})
