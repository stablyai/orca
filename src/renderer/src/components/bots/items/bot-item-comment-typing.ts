// Type-to-focus in an open item: a printable key pressed anywhere in its pane but another input goes
// to the comment box, like the chat composer. Shortcuts (Cmd, Ctrl or Alt), Esc, arrows, Tab and
// keys an IME is composing stay where they are.
import {
  shouldRedirectNativeChatTyping,
  type KeyboardRedirectEvent
} from '@/components/native-chat/composer/focus/native-chat-typing-redirect'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'

type BotItemTypingEvent = KeyboardRedirectEvent & {
  keyCode?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
  preventDefault: () => void
}

function picksChoice(key: string, pane: HTMLElement | null): boolean {
  if (!/^[1-9]$/.test(key)) {
    return false
  }
  const card = pane?.querySelector<HTMLElement>(
    '[data-native-chat-prompt-card-focus][data-native-chat-question-options]'
  )
  return Number(key) <= Number(card?.dataset.nativeChatQuestionOptions ?? 0)
}

/** The open item's pane key handler: sends a typed character to `comment` when it should go there. */
export function typeIntoBotItemComment(
  event: BotItemTypingEvent,
  pane: HTMLElement | null,
  comment: { type: (text: string) => void } | null
): void {
  // Portaled menus and dialogs bubble here through React; only keys from this pane count.
  const inPane = event.target instanceof Node && pane?.contains(event.target) === true
  if (
    !inPane ||
    event.altKey ||
    isImeOwnedKeyboardEvent(event) ||
    !shouldRedirectNativeChatTyping(event, false) ||
    // While the open question's card shows its choices, a digit that names one picks it (the card's
    // own keys); any other digit is typing like any other key.
    picksChoice(event.key, pane)
  ) {
    return
  }
  event.preventDefault()
  comment?.type(event.key)
}
