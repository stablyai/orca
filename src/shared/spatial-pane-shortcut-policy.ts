import type { KeybindingActionId } from './keybindings/types'

export const SPATIAL_PANE_FOCUS_ACTION_IDS = [
  'terminal.focusPaneLeft',
  'terminal.focusPaneRight',
  'terminal.focusPaneUp',
  'terminal.focusPaneDown'
] as const satisfies readonly KeybindingActionId[]

export function matchesSpatialPaneFocusShortcut(
  matches: (action: KeybindingActionId) => boolean
): boolean {
  return SPATIAL_PANE_FOCUS_ACTION_IDS.some(matches)
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
