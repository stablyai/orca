// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { getEffectiveKeybindingsForAction } from '../../../../shared/keybindings'
import {
  DASHBOARD_OPEN_WORKTREE_ACTION_ID,
  dashboardOpenWorktreeShortcutMatchesKeydown
} from './dashboard-open-worktree-shortcut'

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

function match(
  init: KeyboardEventInit,
  options: Parameters<typeof dashboardOpenWorktreeShortcutMatchesKeydown>[1]
): boolean {
  return dashboardOpenWorktreeShortcutMatchesKeydown(keydown(init), options)
}

describe('dashboard open-worktree shortcut', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('ships Cmd+O on macOS and leaves Ctrl+O to the terminal elsewhere', () => {
    expect(getEffectiveKeybindingsForAction(DASHBOARD_OPEN_WORKTREE_ACTION_ID, 'darwin')).toEqual([
      'Mod+O'
    ])
    expect(getEffectiveKeybindingsForAction(DASHBOARD_OPEN_WORKTREE_ACTION_ID, 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction(DASHBOARD_OPEN_WORKTREE_ACTION_ID, 'win32')).toEqual([])

    expect(match({ key: 'o', code: 'KeyO', metaKey: true }, { platform: 'darwin' })).toBe(true)
    // Ctrl+O is a real shell chord, so an unbound Linux default must not claim it.
    expect(match({ key: 'o', code: 'KeyO', ctrlKey: true }, { platform: 'linux' })).toBe(false)
  })

  it('keeps the chord active while the dialog terminal owns focus', () => {
    const terminalInput = document.createElement('textarea')
    terminalInput.className = 'xterm-helper-textarea'
    document.body.append(terminalInput)

    const event = keydown({ key: 'o', code: 'KeyO', metaKey: true })
    terminalInput.dispatchEvent(event)

    expect(
      dashboardOpenWorktreeShortcutMatchesKeydown(event, {
        platform: 'darwin',
        // The user's own policy travels with the event: with Orca-first focus in
        // the PTY still leaves app chords with Orca.
        terminalShortcutPolicy: 'orca-first'
      })
    ).toBe(true)
  })

  it('honors user overrides and ignores repeats or other chords', () => {
    expect(
      match(
        { key: 'o', code: 'KeyO', ctrlKey: true, altKey: true },
        { platform: 'linux', keybindings: { 'dashboard.openWorktree': ['Mod+Alt+O'] } }
      )
    ).toBe(true)
    // An explicit empty binding opts out entirely.
    expect(
      match(
        { key: 'o', code: 'KeyO', metaKey: true },
        { platform: 'darwin', keybindings: { 'dashboard.openWorktree': [] } }
      )
    ).toBe(false)
    // Held keys must not fire repeatedly.
    expect(
      match({ key: 'o', code: 'KeyO', metaKey: true, repeat: true }, { platform: 'darwin' })
    ).toBe(false)
    expect(match({ key: 'p', code: 'KeyP', metaKey: true }, { platform: 'darwin' })).toBe(false)
  })
})
