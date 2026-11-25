import type { RefObject } from 'react'
import type { AgentJournalQuestion } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionPromptResponse } from '../../../../../shared/agent-session/requests/prompts/agent-session-question-answer'
import {
  structuredQuestionAnswers,
  structuredQuestionCard
} from '../../../../../shared/native-chat/input/questions/structured-agent-question-card'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'

export function NativeChatStructuredQuestionCard({
  questions,
  onAnswer,
  onCancel,
  onCollapse,
  isSubmitting,
  shouldFocus,
  answerInputRef
}: {
  questions: readonly AgentJournalQuestion[]
  onAnswer: (response: AgentSessionPromptResponse) => void
  onCancel: () => void
  onCollapse?: () => void
  isSubmitting?: boolean
  shouldFocus?: boolean
  answerInputRef?: RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element {
  const card = structuredQuestionCard(questions)
  return (
    <NativeChatQuestionCard
      prompt={card.prompt}
      allowOther={card.allowOther}
      freeTextInputs={card.freeTextInputs}
      onAnswer={(selections) => {
        const answers = structuredQuestionAnswers(questions, selections)
        if (answers) {
          onAnswer({ kind: 'answers', answers })
        }
      }}
      onCancel={onCancel}
      onCollapse={onCollapse}
      isSubmitting={isSubmitting}
      shouldFocus={shouldFocus}
      answerInputRef={answerInputRef}
    />
  )
}
