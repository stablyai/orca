import { focusNativeChatCover } from '@/components/terminal-pane/chat/native-chat-covered-pane'
import { getOverlayFocusOwners } from '../overlay-focus-ownership'
import type { ManagedPane } from './pane-manager-types'

export function focusPanePreservingOverlays(
  pane: Pick<ManagedPane, 'container' | 'terminal'>
): void {
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
