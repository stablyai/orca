import { nativeChatAskDismissKey } from '../../../../shared/native-chat-ask'
import type { InteractivePromptCard } from './native-chat-interactive-prompt'

/** Equal content keys identify the same prompt; null means no card. */
export function nativeChatCardDismissKey(card: InteractivePromptCard): string | null {
  if (!card) {
    return null
  }
  if (card.kind === 'question') {
    return nativeChatAskDismissKey(card.prompt)
  }
  return `approval:${card.approval.title}:${card.approval.detail ?? ''}`
}
