import { nativeChatAskDismissKey } from './native-chat-ask-dismiss-key'
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

/** The host wait's start for a status-backed card; identical prompt text may belong to separate waits. */
export function nativeChatPromptWaitStartedAt(
  card: InteractivePromptCard,
  status: { interactivePrompt?: string; stateStartedAt?: number } | null | undefined
): number | null {
  return card && status?.interactivePrompt ? (status.stateStartedAt ?? null) : null
}

/** Identifies one prompt occurrence; a new one remounts the card with fresh state. */
export function nativeChatPromptOccurrenceKey(
  card: InteractivePromptCard,
  content: string | null,
  startedAt: number | null
): string | null {
  return content === null || card?.kind !== 'approval' ? content : `${content}@${startedAt}`
}

/** A transcript-only card matches its status-backed record across the post-answer handoff. */
export function nativeChatPromptDismissalMatches(
  dismissal: Readonly<{ content: string; startedAt: number | null }> | undefined,
  content: string | null,
  startedAt: number | null
): boolean {
  return (
    dismissal !== undefined &&
    dismissal.content === content &&
    (startedAt === null || dismissal.startedAt === startedAt)
  )
}
