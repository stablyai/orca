import { nativeChatAskDismissKey } from '../../../../shared/native-chat-ask'
import type { InteractivePromptCard } from './native-chat-interactive-prompt'

/** A stable string identifying a card by its content, or null when there is no
 *  card. Two cards with the same key are treated as "the same prompt". */
export function nativeChatCardDismissKey(card: InteractivePromptCard): string | null {
  if (!card) {
    return null
  }
  if (card.kind === 'question') {
    return nativeChatAskDismissKey(card.prompt)
  }
  return `approval:${card.approval.title}:${card.approval.detail ?? ''}`
}
