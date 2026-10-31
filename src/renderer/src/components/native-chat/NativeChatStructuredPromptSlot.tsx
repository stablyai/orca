import type { ComponentProps, ReactElement, RefObject } from 'react'
import type { StructuredAgentId } from '../../../../shared/agent-session-provider-handle'
import { agentSessionPromptQuestions } from '../../../../shared/agent-session-question-answer'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'
import { chatApprovalFromJournal } from '../../../../shared/native-chat-interactive-prompt'
import type {
  StructuredPromptItem,
  useStructuredAgentSession
} from './use-structured-agent-session'
import type { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'

export function NativeChatStructuredPromptSlot({
  prompt,
  agent,
  controller,
  response,
  shouldFocus,
  answerInputRef,
  asyncQuestion,
  ...fileLinkProps
}: {
  prompt: StructuredPromptItem | null
  agent: StructuredAgentId
  controller: Pick<ReturnType<typeof useStructuredAgentSession>, 'turnId' | 'cancel'>
  response: ReturnType<typeof useStructuredPromptResponseHold>
  shouldFocus: boolean
  answerInputRef: RefObject<HTMLInputElement | null>
  asyncQuestion: ReactElement
} & Pick<
  ComponentProps<typeof NativeChatApprovalCard>,
  'onLinkClick' | 'allowFileUriLinks'
>): React.JSX.Element {
  const approval = prompt?.body.kind === 'approval' ? chatApprovalFromJournal(prompt.body) : null
  const question = prompt?.body.kind === 'question' ? prompt.body : null
  const onCancel = (): void => {
    if (prompt && (controller.turnId || agent === 'pi')) {
      void controller.cancel(controller.turnId ?? undefined, {
        itemId: prompt.itemId,
        expectedRevision: prompt.revision
      })
    }
  }
  return (
    <>
      {prompt && approval ? (
        <NativeChatApprovalCard
          key={`${prompt.itemId}:${prompt.revision}`}
          approval={approval}
          onChoose={(optionId) => void response.respond(prompt, { kind: 'option', optionId })}
          isSubmitting={response.holds(prompt)}
          onCancel={onCancel}
          shouldFocus={shouldFocus}
          {...fileLinkProps}
        />
      ) : null}
      {prompt && question ? (
        <NativeChatStructuredQuestionCard
          key={`${prompt.itemId}:${prompt.revision}`}
          questions={agentSessionPromptQuestions(question)}
          onAnswer={(answer) => void response.respond(prompt, answer)}
          isSubmitting={response.holds(prompt)}
          onCancel={onCancel}
          shouldFocus={shouldFocus}
          answerInputRef={answerInputRef}
        />
      ) : null}
      {asyncQuestion}
    </>
  )
}
