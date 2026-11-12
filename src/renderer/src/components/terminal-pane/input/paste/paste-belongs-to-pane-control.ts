import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import { isInsideNativeChatCover } from '../../chat/native-chat-covered-pane'

/**
 * SETUP-PASTE: a paste (keyboard, app menu, paste event, right-click) aimed at another control inside
 * the pane — the cloud setup strip's code field, the search box, the chat cover, any input or textarea
 * that isn't xterm's own — is that control's, never the shell's. Pane strips are portaled into the
 * pane container, so the terminal's capture listeners see their events first.
 */
export function pasteBelongsToPaneControl(target: EventTarget | null): boolean {
  return (
    (target instanceof Element &&
      (target.closest('[data-terminal-search-root]') !== null ||
        target.closest('[data-cloud-sign-in-strip]') !== null)) ||
    isInsideNativeChatCover(target) ||
    isEditableTarget(target)
  )
}
