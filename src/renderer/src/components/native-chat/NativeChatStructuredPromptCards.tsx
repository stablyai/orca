import type { RefObject } from 'react'
import { agentSessionPromptQuestions } from '../../../../shared/agent-session-question-answer'
import { NativeChatApprovalCard, type NativeChatApprovalCardProps } from './NativeChatApprovalCard'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'
import { chatApprovalFromJournal } from './native-chat-interactive-prompt'
import type { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'

type PromptResponse = ReturnType<typeof useStructuredPromptResponseHold>

export function NativeChatStructuredPromptCards({
  prompt,
  response,
  onCancel,
  shouldFocus,
  answerInputRef,
  ...fileLinks
}: {
  prompt: Parameters<PromptResponse['respond']>[0] | null
  response: PromptResponse
  onCancel: () => void
  shouldFocus: boolean
  answerInputRef: RefObject<HTMLInputElement | null>
} & Pick<
  NativeChatApprovalCardProps,
  'onLinkClick' | 'allowFileUriLinks'
>): React.JSX.Element | null {
  if (!prompt) {
    return null
  }
  const approval = prompt.body.kind === 'approval' ? chatApprovalFromJournal(prompt.body) : null
  if (approval) {
    return (
      <NativeChatApprovalCard
        key={`${prompt.itemId}:${prompt.revision}`}
        approval={approval}
        onChoose={(optionId) => void response.respond(prompt, { kind: 'option', optionId })}
        isSubmitting={response.holds(prompt)}
        onCancel={onCancel}
        shouldFocus={shouldFocus}
        {...fileLinks}
      />
    )
  }
  return prompt.body.kind === 'question' ? (
    <NativeChatStructuredQuestionCard
      key={`${prompt.itemId}:${prompt.revision}`}
      questions={agentSessionPromptQuestions(prompt.body)}
      onAnswer={(answer) => void response.respond(prompt, answer)}
      isSubmitting={response.holds(prompt)}
      onCancel={onCancel}
      shouldFocus={shouldFocus}
      answerInputRef={answerInputRef}
    />
  ) : null
}
