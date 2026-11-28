// Pieces of the question card: another surface's look and draft for it, Enter on the card, and Escape to fold it.
import { useEffect, useEffectEvent, type RefObject } from 'react'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import type { AgentJournalFreeTextInput } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AskAnswerSelection } from '../../../../../shared/native-chat/input/questions/native-chat-ask-answer'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'

/** Another surface's own look for the question card. */
export type NativeChatQuestionCardLook = {
  /** The outer frame, where the surface's fill and gutter differ from chat's. */
  frameClassName?: string
  /** Emphasis on the bordered body. */
  surfaceClassName?: string
  /** A line below the band question (who asks, and that it waits on you). */
  header?: React.ReactNode
  /** Draws the question's words in place of the plain heading (an item clamps a long ask). */
  renderQuestion?: (content: string) => React.ReactNode
}

/** An answer in progress the card starts from and reports back to, kept by its surface across remounts
 *  (an item's ask keeps the owner's picks and words until they send or recover them). */
export type NativeChatQuestionCardDraft = {
  selections: number[][]
  otherText: string[]
  onChange: (selections: number[][], otherText: string[]) => void
}

export type NativeChatQuestionCardProps = {
  prompt: AskPrompt
  /** Whether the snapshotted answer is still being delivered to the agent. */
  isSubmitting?: boolean
  isCancelling?: boolean
  /** Deliver the chosen answer (per-question option indices + free text). */
  onAnswer: (selections: AskAnswerSelection[]) => void
  allowOther?: boolean | readonly boolean[]
  freeTextInputs?: readonly (AgentJournalFreeTextInput | undefined)[]
  /** Dismiss the prompt (sends Escape to the agent). Without it (an item's question has nothing
   *  to dismiss) the card has no ×, and an unanswered last step shows Submit, off, instead of Skip. */
  onCancel?: () => void
  /** A caller that can dismiss but needs every answer returns to an unanswered step. */
  requiresEveryAnswer?: boolean
  /** Fold the card to a strip and give the input back, writing nothing; Escape does too. */
  onCollapse?: () => void
  /** Take focus when the card takes the input region; number keys pick while it holds. */
  shouldFocus?: boolean
  /** Paste target while the card replaces the composer. */
  answerInputRef?: RefObject<HTMLTextAreaElement | null>
  /** Another surface's own look for the card (an item page's open question). */
  look?: NativeChatQuestionCardLook
  draft?: NativeChatQuestionCardDraft
  /** The prompt's identity in its chat, so a half-made answer survives the chat view being released. */
  memoryKey?: string
}

/** Reports the card's picks and words to its draft as they change. */
export function useReportNativeChatQuestionDraft(
  draft: NativeChatQuestionCardDraft | undefined,
  selections: number[][],
  otherText: string[]
): void {
  const report = useEffectEvent(() => draft?.onChange(selections, otherText))
  useEffect(() => report(), [selections, otherText])
}

/** Escape folds the card, unless it comes from a text field: Escape there is editing, and folding would
 *  hide the draft. */
export function foldNativeChatQuestionOnEscape(
  event: React.KeyboardEvent,
  collapse: (() => void) | undefined
): void {
  if (
    event.key === 'Escape' &&
    !event.nativeEvent.isComposing &&
    collapse &&
    !isEditableTarget(event.target)
  ) {
    event.preventDefault()
    event.stopPropagation()
    collapse()
  }
}

/** Enter on the card itself confirms an answered step; a child's own Enter never lands here as target.
 *  True when it took the key. */
export function confirmNativeChatQuestionOnCardEnter(
  event: React.KeyboardEvent,
  answered: boolean,
  confirm: () => void
): boolean {
  const modified = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat
  if (
    event.key !== 'Enter' ||
    event.target !== event.currentTarget ||
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    modified
  ) {
    return false
  }
  event.preventDefault()
  if (answered) {
    confirm()
  }
  return true
}
