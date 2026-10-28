import { describe, expect, it } from 'vitest'
import { resolveBrowserChromeShortcutScope } from './browser-chrome-shortcut-scope'

const focusedWorkspaceBrowser = {
  isActive: true,
  isWorktreeFocused: true,
  isFloatingWorkspace: false,
  focusedGroupId: 'group-a',
  groupId: 'group-a'
}

describe('resolveBrowserChromeShortcutScope', () => {
  it('lets the focused split of the focused workspace answer window-wide chords', () => {
    expect(resolveBrowserChromeShortcutScope(focusedWorkspaceBrowser)).toBe('focused')
  })

  it('keeps an unfocused grid view cell from answering Cmd/Ctrl+L or Cmd/Ctrl+F', () => {
    // Why: several cells can each show a browser in their own focused split at once.
    expect(
      resolveBrowserChromeShortcutScope({ ...focusedWorkspaceBrowser, isWorktreeFocused: false })
    ).toBe('inactive')
  })

  it('leaves a browser in another split of the focused workspace inactive (#11348)', () => {
    expect(
      resolveBrowserChromeShortcutScope({ ...focusedWorkspaceBrowser, groupId: 'group-b' })
    ).toBe('inactive')
  })

  it('limits a floating browser to chords aimed at its own overlay', () => {
    expect(
      resolveBrowserChromeShortcutScope({ ...focusedWorkspaceBrowser, isFloatingWorkspace: true })
    ).toBe('owned-target')
  })

  it('answers nothing while the browser is not showing', () => {
    expect(resolveBrowserChromeShortcutScope({ ...focusedWorkspaceBrowser, isActive: false })).toBe(
      'inactive'
    )
  })
})
