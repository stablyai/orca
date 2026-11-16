import { focusNativeChatCover } from '@/components/terminal-pane/chat/native-chat-covered-pane'
import { isDocumentBodyOrNull } from '@/components/terminal-pane/input/ime/terminal-ime-input-context-refresh'
import { getOverlayFocusOwners } from '../../overlay-interaction/overlay-focus-ownership'
import type { ManagedPane } from '../pane-manager-types'

type OverlayFocusablePane = {
  container: ManagedPane['container']
  terminal: Pick<ManagedPane['terminal'], 'focus'>
}

export function focusPanePreservingOverlays(pane: OverlayFocusablePane): void {
  if (
    typeof document !== 'undefined' &&
    (document.activeElement?.matches('[data-worktree-sidebar][data-keyboard-navigation]') ||
      getOverlayFocusOwners(pane.container).length > 0)
  ) {
    return
  }
  if (focusNativeChatCover(pane)) {
    return
  }
  pane.terminal.focus()
}

/** Refocus only when focus fell to <body>, so an intentionally focused control keeps it. */
export function focusPaneIfFocusUnclaimed(pane: OverlayFocusablePane | null): void {
  if (
    pane &&
    typeof document !== 'undefined' &&
    isDocumentBodyOrNull(document.activeElement, document)
  ) {
    focusPanePreservingOverlays(pane)
  }
}
