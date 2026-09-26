import { hasVisibleOverlay } from '../visible-overlay'
import { isWorktreeListKeyboardNavigationActive } from '../worktree-list-keyboard-navigation'
import type { ManagedPane } from './pane-manager-types'

export function focusPanePreservingOverlays(
  pane: Pick<ManagedPane, 'container' | 'terminal'>
): void {
  if (isWorktreeListKeyboardNavigationActive()) {
    return
  }
  if (
    typeof document !== 'undefined' &&
    hasVisibleOverlay({
      ignoreMatches: '[role="listbox"][data-worktree-sidebar]',
      ignoreContaining: pane.container,
      ignoreDismissed: true
    })
  ) {
    return
  }
  pane.terminal.focus()
}
