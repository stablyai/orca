import { describe, expect, it } from 'vitest'
import { keybindingMatchesAction, type KeybindingActionId } from './keybindings'
import {
  matchesSpatialPaneFocusShortcut,
  resolveWorktreeHistoryShortcut
} from './spatial-pane-shortcut-policy'

describe('spatial/history matching across client platforms', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'honors active bindings and terminal policy on %s',
    (platform) => {
      const event = {
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        meta: platform === 'darwin',
        control: platform !== 'darwin',
        alt: true
      }
      for (const terminalShortcutPolicy of ['orca-first', 'terminal-first'] as const) {
        const matches = (action: KeybindingActionId) =>
          keybindingMatchesAction(action, event, platform, undefined, {
            context: 'terminal',
            terminalShortcutPolicy
          })
        expect(matchesSpatialPaneFocusShortcut(matches)).toBe(true)
        expect(resolveWorktreeHistoryShortcut(matches)).toBe(
          terminalShortcutPolicy === 'orca-first' ? 'worktree.history.back' : null
        )
      }
      const overrides = { 'terminal.focusPaneLeft': ['Ctrl+H'], 'worktree.history.back': [] }
      const matches = (action: KeybindingActionId) =>
        keybindingMatchesAction(action, event, platform, overrides, { context: 'terminal' })
      expect(matchesSpatialPaneFocusShortcut(matches)).toBe(false)
      expect(resolveWorktreeHistoryShortcut(matches)).toBeNull()
    }
  )
})
