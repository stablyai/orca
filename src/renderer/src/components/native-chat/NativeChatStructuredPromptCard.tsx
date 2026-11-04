import type { RefObject } from 'react'
import { NativeChatApprovalCard, type NativeChatApprovalCardProps } from './NativeChatApprovalCard'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'
import { agentSessionPromptQuestions } from '../../../../shared/agent-session/agent-session-question-answer'
import { chatApprovalFromJournal } from '../../../../shared/native-chat/input/native-chat-interactive-prompt'
import type { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'

type Response = ReturnType<typeof useStructuredPromptResponseHold>
type Prompt = Parameters<Response['respond']>[0]

/** The pending prompt's card: an approval (or its form) or a question, answered through one hold. */
export function NativeChatStructuredPromptCard({
  prompt,
  response,
  answerInputRef,
  ...props
}: Omit<NativeChatApprovalCardProps, 'approval' | 'onChoose' | 'onSubmitForm' | 'isSubmitting'> & {
  prompt: Prompt
  response: Response
  onCancel: () => void
  answerInputRef: RefObject<HTMLInputElement | null>
}) {
  if (prompt.body.kind === 'question') {
    return (
      <NativeChatStructuredQuestionCard
        questions={agentSessionPromptQuestions(prompt.body)}
        onAnswer={(answer) => void response.respond(prompt, answer)}
        isSubmitting={response.holds(prompt)}
        onCancel={props.onCancel}
        shouldFocus={props.shouldFocus}
        answerInputRef={answerInputRef}
        onLinkClick={props.onLinkClick}
      />
    )
  }
  if (prompt.body.kind !== 'approval') {
    return null
  }
  return (
    <NativeChatApprovalCard
      {...props}
      approval={chatApprovalFromJournal(prompt.body)}
      onChoose={(optionId) => void response.respond(prompt, { kind: 'option', optionId })}
      onSubmitForm={(content) => void response.respond(prompt, { kind: 'form', content })}
      isSubmitting={response.holds(prompt)}
    />
  )
}
