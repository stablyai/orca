import type { RefObject } from 'react'
import { agentSessionPromptQuestions } from '../../../../../shared/agent-session/agent-session-question-answer'
import { chatApprovalFromJournal } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'
import type { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'

type PromptResponse = ReturnType<typeof useStructuredPromptResponseHold>
type PromptItem = Parameters<PromptResponse['holds']>[0]

/** The chat's own open prompt in the slot above the message box: an approval or a question card. */
export function NativeChatStructuredPromptCard({
  prompt,
  promptResponse,
  onCancel,
  shouldFocus,
  answerInputRef
}: {
  prompt: PromptItem | null
  promptResponse: PromptResponse
  onCancel: () => void
  shouldFocus: boolean
  answerInputRef: RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element | null {
  if (prompt?.body.kind === 'approval') {
    return (
      <NativeChatApprovalCard
        approval={chatApprovalFromJournal(prompt.body)}
        onChoose={(optionId) => void promptResponse.respond(prompt, { kind: 'option', optionId })}
        isSubmitting={promptResponse.holds(prompt)}
        onCancel={onCancel}
        shouldFocus={shouldFocus}
      />
    )
  }
  if (prompt?.body.kind === 'question') {
    return (
      <NativeChatStructuredQuestionCard
        questions={agentSessionPromptQuestions(prompt.body)}
        onAnswer={(response) => void promptResponse.respond(prompt, response)}
        isSubmitting={promptResponse.holds(prompt)}
        onCancel={onCancel}
        shouldFocus={shouldFocus}
        answerInputRef={answerInputRef}
      />
    )
  }
  return null
}
