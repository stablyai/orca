import { hasVisibleOverlay } from '../visible-overlay'
import type { ManagedPane } from './pane-manager-types'

export function focusPanePreservingOverlays(
  pane: Pick<ManagedPane, 'container' | 'terminal'>
): void {
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
