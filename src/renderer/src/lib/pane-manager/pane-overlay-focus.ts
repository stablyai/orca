import { focusNativeChatCover } from '@/components/terminal-pane/native-chat-covered-pane'
import { isDocumentBodyOrNull } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
import { hasVisibleOverlay } from '../visible-overlay'
import type { ManagedPane } from './pane-manager-types'

export function focusPanePreservingOverlays(
  pane: Pick<ManagedPane, 'container' | 'terminal'>
): void {
  if (
    typeof document !== 'undefined' &&
    (document.activeElement?.matches('[data-worktree-sidebar][data-keyboard-navigation]') ||
      hasVisibleOverlay({
        ignoreMatches: '[role="listbox"][data-worktree-sidebar]',
        ignoreContaining: pane.container,
        ignoreDismissed: true
      }))
  ) {
    return
  }
  if (focusNativeChatCover(pane)) {
    return
  }
  pane.terminal.focus()
}

/** Refocus only when focus fell to <body>, so an intentionally focused control keeps it. */
export function focusPaneIfFocusUnclaimed(
  pane: Pick<ManagedPane, 'container' | 'terminal'> | null
): void {
  if (pane && isDocumentBodyOrNull(document.activeElement, document)) {
    focusPanePreservingOverlays(pane)
  }
}
