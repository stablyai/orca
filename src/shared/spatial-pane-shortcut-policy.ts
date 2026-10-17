import type { KeybindingActionId } from './keybindings'

export function matchesSpatialPaneFocusShortcut(
  matches: (action: KeybindingActionId) => boolean
): boolean {
  return (
    matches('terminal.focusPaneLeft') ||
    matches('terminal.focusPaneRight') ||
    matches('terminal.focusPaneUp') ||
    matches('terminal.focusPaneDown')
  )
}

export function resolveWorktreeHistoryShortcut(
  matches: (action: KeybindingActionId) => boolean
): 'worktree.history.back' | 'worktree.history.forward' | null {
  if (matches('worktree.history.back')) {
    return 'worktree.history.back'
  }
  if (matches('worktree.history.forward')) {
    return 'worktree.history.forward'
  }
  return null
}
