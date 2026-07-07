// Pure content key for an interactive card (question / approval), used to dismiss
// it once answered. The live status lingers briefly — the agent emits a post-tool
// event carrying the same prompt — so the view hides the card until a genuinely
// different prompt arrives. Keying by content (not identity) means an identical
// follow-up prompt only re-shows after the prompt has cleared in between. Mirrors
// mobile's askKey/dismissedAskKey. Kept pure so the keying is unit-testable.

import type { InteractivePromptCard } from './native-chat-interactive-prompt'

/** A stable string identifying a card by its content, or null when there is no
 *  card. Two cards with the same key are treated as "the same prompt". */
export function nativeChatCardDismissKey(card: InteractivePromptCard): string | null {
  if (!card) {
    return null
  }
  if (card.kind === 'question') {
    const { questions } = card.prompt
    return `question:${questions.length}:${questions[0]?.question ?? ''}`
  }
  return `approval:${card.approval.title}:${card.approval.detail ?? ''}`
}
