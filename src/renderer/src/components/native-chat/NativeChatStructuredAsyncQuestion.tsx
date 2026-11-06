import { chatApprovalFromJournal } from '../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { cancelStructuredPrompt } from './native-chat-structured-stop-controls'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { agentSessionPromptQuestions } from '../../../../shared/agent-session/agent-session-question-answer'
import type { RefObject } from 'react'
import type { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'
import { asyncQuestionSourceScope } from '../../../../shared/native-chat/input/native-chat-ask'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { structuredAgentSessionHostKey } from '../../runtime/structured-agent-session-host-capability'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import { nativeChatAskDismissKey } from '../../../../shared/native-chat/input/native-chat-ask-dismiss-key'
import { useMemo, useState } from 'react'
import type { QueuedMessageCard } from '../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AskPrompt } from '../../../../shared/native-chat/input/native-chat-ask-types'
import {
  nativeChatAnswerOperationPending,
  type NativeChatAnswerOperation,
  formatAskAnswer
} from '../../../../shared/native-chat/input/native-chat-ask-answer'
import { nativeChatAnswerSendIntent } from '../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { useNativeChatAsyncQuestions } from './use-native-chat-async-questions'

const NO_SUBMISSIONS: readonly AgentJournalSubmission[] = []

/** Async questions leave the composer usable; the next ordinary send answers them and Cancel only hides them. */
export function NativeChatStructuredAsyncQuestion({
  paneKey,
  session,
  sourceKey,
  sourceScope,
  blocked = false,
  send,
  sendFollowUp,
  queuedCards,
  submissions = NO_SUBMISSIONS
}: {
  paneKey: string
  sourceKey: string
  sourceScope: string
  blocked?: boolean
  session: Pick<NativeChatLiveSession, 'messages' | 'readPhase'>
  send: NativeChatStructuredComposerTransport['send']
  sendFollowUp?: NativeChatStructuredComposerTransport['sendFollowUp']
  queuedCards?: readonly Pick<QueuedMessageCard, 'text'>[]
  submissions?: readonly AgentJournalSubmission[]
}): React.JSX.Element | null {
  const queuedTexts = useMemo(() => queuedCards?.map((card) => card.text), [queuedCards])
  const { prompt, dismiss, ownerKey, answerPending } = useNativeChatAsyncQuestions({
    paneKey,
    sourceKey,
    sourceScope,
    viewKey: paneKey,
    messages: session.messages,
    settled: session.readPhase === 'ready' && !blocked,
    queuedTexts
  })
  if (!prompt) {
    return null
  }
  return (
    <NativeChatAsyncQuestionForm
      key={JSON.stringify([ownerKey, nativeChatAskDismissKey(prompt)])}
      {...{ prompt, session, send, sendFollowUp, submissions, answerPending }}
      onCancel={dismiss}
    />
  )
}

function NativeChatAsyncQuestionForm({
  prompt,
  session,
  send,
  sendFollowUp,
  submissions,
  answerPending,
  onCancel
}: {
  prompt: AskPrompt
  session: Pick<NativeChatLiveSession, 'messages'>
  send: NativeChatStructuredComposerTransport['send']
  sendFollowUp?: NativeChatStructuredComposerTransport['sendFollowUp']
  submissions: readonly AgentJournalSubmission[]
  answerPending: boolean
  onCancel: () => void
}): React.JSX.Element {
  const [operation, setOperation] = useState<NativeChatAnswerOperation | null>(null)
  return (
    <NativeChatQuestionCard
      prompt={prompt}
      isSubmitting={
        answerPending || nativeChatAnswerOperationPending(operation, session.messages, submissions)
      }
      onAnswer={(selections) => {
        const current: NativeChatAnswerOperation = { inFlight: true }
        const sent = send(formatAskAnswer(prompt, selections), [], {
          ...nativeChatAnswerSendIntent(sendFollowUp),
          callerKeepsText: true,
          onCreated: (id) => {
            current.clientMessageId = id
          },
          onSettled: () =>
            setOperation((active) =>
              active === current ? { ...current, inFlight: false } : active
            )
        })
        if (sent) {
          setOperation(current)
        }
      }}
      onCancel={onCancel}
    />
  )
}

export function nativeChatStructuredAsyncQuestion(
  props: Pick<NativeChatStructuredViewProps, 'target' | 'agent' | 'sessionId' | 'tabId'>,
  controller: Pick<
    ReturnType<typeof useStructuredAgentSession>,
    'epoch' | 'prompts' | 'submissions'
  >,
  session: Pick<NativeChatLiveSession, 'messages' | 'readPhase'>,
  transport: Pick<NativeChatStructuredComposerTransport, 'send' | 'sendFollowUp'>,
  submits: { queuedMessages: { cards: readonly Pick<QueuedMessageCard, 'text'>[] } }
): React.JSX.Element {
  const { agent, sessionId } = props
  const { epoch } = controller
  return (
    <NativeChatStructuredAsyncQuestion
      paneKey={structuredAgentSessionPaneKey(props.tabId, sessionId)}
      session={session}
      submissions={controller.submissions}
      send={transport.send}
      sendFollowUp={transport.sendFollowUp}
      queuedCards={submits.queuedMessages.cards}
      blocked={controller.prompts[0] != null}
      sourceKey={JSON.stringify([
        'journal',
        structuredAgentSessionHostKey(props.target),
        agent,
        sessionId,
        epoch
      ])}
      sourceScope={asyncQuestionSourceScope({ kind: 'journal', agent, sessionId, epoch })}
    />
  )
}

export function NativeChatStructuredPrompts({
  pane,
  controller,
  response,
  session,
  transport,
  submits,
  shouldFocus,
  answerInputRef
}: {
  pane: Pick<
    NativeChatStructuredViewProps,
    'target' | 'agent' | 'sessionId' | 'tabId' | 'isVisible'
  >
  controller: ReturnType<typeof useStructuredAgentSession>
  response: ReturnType<typeof useStructuredPromptResponseHold>
  session: Pick<NativeChatLiveSession, 'messages' | 'readPhase'>
  transport: NativeChatStructuredComposerTransport
  submits: { queuedMessages: { cards: readonly Pick<QueuedMessageCard, 'text'>[] } }
  shouldFocus: boolean
  answerInputRef: RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element {
  const prompt = controller.prompts[0] ?? null
  const questionBody = prompt?.body.kind === 'question' ? prompt.body : null
  const approval = prompt?.body.kind === 'approval' ? chatApprovalFromJournal(prompt.body) : null
  const cancelPrompt = () => cancelStructuredPrompt(controller, prompt)
  return (
    <>
      {prompt && approval ? (
        <NativeChatApprovalCard
          key={`${prompt.itemId}:${prompt.revision}`}
          approval={approval}
          onChoose={(optionId) => void response.respond(prompt, { kind: 'option', optionId })}
          isSubmitting={response.holds(prompt)}
          onCancel={cancelPrompt}
          shouldFocus={shouldFocus}
        />
      ) : null}
      {prompt && questionBody ? (
        <NativeChatStructuredQuestionCard
          key={`${prompt.itemId}:${prompt.revision}`}
          questions={agentSessionPromptQuestions(questionBody)}
          onAnswer={(answer) => void response.respond(prompt, answer)}
          isSubmitting={response.holds(prompt)}
          onCancel={cancelPrompt}
          shouldFocus={shouldFocus}
          answerInputRef={answerInputRef}
        />
      ) : null}
      {nativeChatStructuredAsyncQuestion(pane, controller, session, transport, submits)}
    </>
  )
}
