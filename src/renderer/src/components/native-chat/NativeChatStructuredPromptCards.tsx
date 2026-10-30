import type { ComponentProps, RefObject } from 'react'
import { agentSessionPromptQuestions } from '../../../../shared/agent-session-question-answer'
import { chatApprovalFromJournal } from '../../../../shared/native-chat-interactive-prompt'
import type {
  StructuredPromptItem,
  useStructuredAgentSession
} from './use-structured-agent-session'
import type { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'

type Props = {
  prompt: StructuredPromptItem | null
  controller: Pick<
    ReturnType<typeof useStructuredAgentSession>,
    'turnId' | 'cancel' | 'promptsReady'
  >
  agent: string
  promptResponse: ReturnType<typeof useStructuredPromptResponseHold>
  shouldFocus: boolean
  fileLinkProps: Pick<
    ComponentProps<typeof NativeChatApprovalCard>,
    'onLinkClick' | 'allowFileUriLinks'
  >
  answerInputRef: RefObject<HTMLInputElement | null>
}

export function NativeChatStructuredPromptCards({
  prompt,
  controller,
  agent,
  promptResponse,
  shouldFocus,
  fileLinkProps,
  answerInputRef
}: Props) {
  const approval = prompt?.body.kind === 'approval' ? chatApprovalFromJournal(prompt.body) : null
  const questionBody = prompt?.body.kind === 'question' ? prompt.body : null
  const cancelPrompt = () => {
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
          onChoose={(optionId) => void promptResponse.respond(prompt, { kind: 'option', optionId })}
          disabled={controller.promptsReady === false}
          isSubmitting={promptResponse.holds(prompt)}
          onCancel={cancelPrompt}
          shouldFocus={shouldFocus}
          {...fileLinkProps}
        />
      ) : null}
      {prompt && questionBody ? (
        <NativeChatStructuredQuestionCard
          key={`${prompt.itemId}:${prompt.revision}`}
          questions={agentSessionPromptQuestions(questionBody)}
          onAnswer={(response) => void promptResponse.respond(prompt, response)}
          disabled={controller.promptsReady === false}
          isSubmitting={promptResponse.holds(prompt)}
          onCancel={cancelPrompt}
          shouldFocus={shouldFocus}
          answerInputRef={answerInputRef}
        />
      ) : null}
    </>
  )
}
