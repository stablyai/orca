import type { RefObject } from 'react'
import type { AskAnswerSelection } from '../../../../../shared/native-chat/input/questions/native-chat-ask-answer'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'
import type { AgentJournalFreeTextInput } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  NativeChatQuestionCardDraft,
  NativeChatQuestionCardLook
} from './NativeChatQuestionCardParts'

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
  /** The caller sends only a whole answer even though it can dismiss: no "Skip and submit", and
   *  Submit with a step left open goes to that step. */
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
}
