import type { RefObject } from 'react'
import { useStructuredAgentSessionHostApprovalFeedback } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { agentSessionPromptQuestions } from '../../../../../shared/agent-session/agent-session-question-answer'
import { chatApprovalFromJournal } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'
import type { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'

type PromptResponse = ReturnType<typeof useStructuredPromptResponseHold>
type PromptItem = Parameters<PromptResponse['holds']>[0]

/** The chat's own open prompt in the slot above the message box: an approval or a question card. */
export function NativeChatStructuredPromptCard({
  target,
  prompt,
  promptResponse,
  onCancel,
  shouldFocus,
  answerInputRef
}: {
  target: RuntimeClientTarget
  prompt: PromptItem | null
  promptResponse: PromptResponse
  onCancel: () => void
  shouldFocus: boolean
  answerInputRef: RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element | null {
  const supportsApprovalFeedback = useStructuredAgentSessionHostApprovalFeedback(target)
  if (prompt?.body.kind === 'approval') {
    const approval = chatApprovalFromJournal(prompt.body)
    return (
      <NativeChatApprovalCard
        approval={
          supportsApprovalFeedback || !approval.freeTextInput
            ? approval
            : { ...approval, freeTextInput: undefined }
        }
        onChoose={(optionId, feedback) =>
          void promptResponse.respond(prompt, {
            kind: 'option',
            optionId,
            ...(feedback !== undefined ? { feedback } : {})
          })
        }
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
