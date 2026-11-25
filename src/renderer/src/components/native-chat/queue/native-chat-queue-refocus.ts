import { NATIVE_CHAT_ROOT_SELECTOR } from '@/components/native-chat/paste/native-chat-paste-request'
import { focusNativeChatPromptCard } from '../prompts/use-native-chat-prompt-card-focus'

/** Once a queue action settles, focus left on the queue or dropped with a removed control goes to
 *  the active prompt card, else the composer. */
export function refocusAfterQueueAction(
  action: Promise<unknown>,
  anchor: Element | null,
  focusComposer: (() => void) | undefined
): void {
  // Read before the action, which may unmount the control.
  const root = anchor?.closest(NATIVE_CHAT_ROOT_SELECTOR)
  void action.then(() => {
    const active = document.activeElement
    if (!active || active === document.body || !active.isConnected || anchor?.contains(active)) {
      if (!root || !focusNativeChatPromptCard(root, null)) {
        focusComposer?.()
      }
    }
  })
}
