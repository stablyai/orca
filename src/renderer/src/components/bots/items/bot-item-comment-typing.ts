// Type-to-focus in an open item: a printable key pressed anywhere in its pane but another input goes
// to the comment box, like the chat composer. Shortcuts (Cmd, Ctrl or Alt), Esc, arrows, Tab and
// keys an IME is composing stay where they are.
import {
  shouldFocusNativeChatInputForPaste,
  shouldRedirectNativeChatTyping,
  type KeyboardRedirectEvent
} from '@/components/native-chat/composer/focus/native-chat-typing-redirect'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'

type BotItemTypingEvent = KeyboardRedirectEvent & {
  keyCode?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
  preventDefault: () => void
}

/** How many digit keys an open ask's reply rows take in Activity. */
export const BOT_ITEM_CHOICES_ATTRIBUTE = 'data-bot-item-choices'

function picksChoice(key: string, pane: HTMLElement | null): boolean {
  if (!/^[1-9]$/.test(key)) {
    return false
  }
  const card = pane?.querySelector<HTMLElement>(
    '[data-native-chat-prompt-card-focus][data-native-chat-question-options]'
  )
  // The open ask's reply rows in Activity take their own digits too.
  const rows = pane?.querySelector<HTMLElement>(`[${BOT_ITEM_CHOICES_ATTRIBUTE}]`)
  const count = Math.max(
    Number(card?.dataset.nativeChatQuestionOptions ?? 0),
    Number(rows?.getAttribute(BOT_ITEM_CHOICES_ATTRIBUTE) ?? 0)
  )
  return Number(key) <= count
}

/** The open item's pane key handler: sends a typed character to `comment` when it should go there, and
 *  a paste: the box takes focus before it lands, so the paste goes in (and the box opens) as typed. */
export function typeIntoBotItemComment(
  event: BotItemTypingEvent,
  pane: HTMLElement | null,
  comment: { type: (text: string) => void; focusEnd?: () => void } | null
): void {
  // Portaled menus and dialogs bubble here through React; only keys from this pane count.
  const inPane = event.target instanceof Node && pane?.contains(event.target) === true
  if (!inPane || isImeOwnedKeyboardEvent(event)) {
    return
  }
  if (shouldFocusNativeChatInputForPaste(event, getShortcutPlatform() === 'darwin')) {
    comment?.focusEnd?.()
    return
  }
  if (
    event.altKey ||
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
