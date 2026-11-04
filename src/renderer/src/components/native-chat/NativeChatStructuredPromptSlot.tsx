import { cancelStructuredPrompt } from './native-chat-structured-stop-controls'
import type { ComponentProps, RefObject } from 'react'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { agentSessionPromptQuestions } from '../../../../shared/agent-session/agent-session-question-answer'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'
import { chatApprovalFromJournal } from '../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { nativeChatStructuredAsyncQuestion } from './NativeChatStructuredAsyncQuestion'
import type { useStructuredAgentSession } from './use-structured-agent-session'

type AsyncQuestionContext = Parameters<typeof nativeChatStructuredAsyncQuestion>
import type { StructuredPromptItem } from '../../../../shared/agent-session/view/structured-agent-session-message-projection'
import type { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'

export function NativeChatStructuredPromptSlot({
  prompt,
  agent,
  controller,
  response,
  shouldFocus,
  answerInputRef,
  pane,
  session,
  transport,
  submits,
  ...fileLinkProps
}: {
  prompt: StructuredPromptItem | null
  agent: StructuredAgentId
  controller: AsyncQuestionContext[1] &
    Pick<ReturnType<typeof useStructuredAgentSession>, 'turnId' | 'cancel'>
  response: ReturnType<typeof useStructuredPromptResponseHold>
  shouldFocus: boolean
  answerInputRef: RefObject<HTMLInputElement | null>
  pane: AsyncQuestionContext[0]
  session: AsyncQuestionContext[2]
  transport: AsyncQuestionContext[3]
  submits: AsyncQuestionContext[4]
} & Pick<
  ComponentProps<typeof NativeChatApprovalCard>,
  'onLinkClick' | 'allowFileUriLinks'
>): React.JSX.Element {
  const approval = prompt?.body.kind === 'approval' ? chatApprovalFromJournal(prompt.body) : null
  const question = prompt?.body.kind === 'question' ? prompt.body : null
  const onCancel = () => cancelStructuredPrompt(controller, prompt, agent)

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
          {...fileLinkProps}
        />
      ) : null}
      {nativeChatStructuredAsyncQuestion(
        pane,
        controller,
        session,
        transport,
        submits,
        fileLinkProps
      )}
    </>
  )
}
