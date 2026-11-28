import { asyncQuestionSourceScope } from '../../../../../shared/native-chat/input/native-chat-ask'
import { structuredAgentSessionHostKey } from '../../../runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import type { NativeChatStructuredViewProps } from '../native-chat-view-types'
import type { useStructuredAgentSession } from '../session/structured/use-structured-agent-session'
import { nativeChatAskDismissKey } from '../../../../../shared/native-chat/input/questions/native-chat-ask-dismiss-key'
import { useEffect, useMemo } from 'react'
import {
  KEPT_PROMPT_VIEWS,
  useNativeChatViewState
} from '../pane/ownership/native-chat-view-memory'
import type { QueuedMessageCard } from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import type { AgentJournalSubmission } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  nativeChatAnswerOperationEvidence,
  nativeChatAnswerOperationPending,
  type NativeChatAnswerOperation,
  formatAskAnswer
} from '../../../../../shared/native-chat/input/questions/native-chat-ask-answer'
import { nativeChatAnswerSendIntent } from '../../../../../shared/native-chat/input/composer/native-chat-follow-up-behavior'
import type { NativeChatStructuredComposerTransport } from '../composer/submit/native-chat-structured-composer-transport'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import type { NativeChatLiveSession } from '../session/terminal/read/native-chat-live-session-contract'
import { useNativeChatAsyncQuestions } from './use-native-chat-async-questions'
import { projectionBesideStreamedText } from '../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import {
  useStructuredAgentSessionAsyncQuestionSkip,
  type StructuredAgentSessionAsyncQuestionSkip
} from './use-structured-agent-session-async-question-skip'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { chatPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'

const NO_SUBMISSIONS: readonly AgentJournalSubmission[] = []

type PromptAnswerOperation = NativeChatAnswerOperation & { promptKey: string }

/** Async questions leave the composer usable; the next ordinary send answers them, and Skip hides
 *  them on every device where the host saves it, else on this screen only. */
export function NativeChatStructuredAsyncQuestion({
  paneKey,
  skip,
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
  /** The host's saved Skip; absent on a host that keeps none. */
  skip?: StructuredAgentSessionAsyncQuestionSkip
  sourceKey: string
  sourceScope: string
  blocked?: boolean
  session: Pick<NativeChatLiveSession, 'messages' | 'readPhase'>
  send: NativeChatStructuredComposerTransport['send']
  sendFollowUp?: NativeChatStructuredComposerTransport['sendFollowUp']
  queuedCards?: readonly Pick<QueuedMessageCard, 'text'>[]
  submissions?: readonly AgentJournalSubmission[]
}): React.JSX.Element | null {
  // Kept with the chat tab: a chat released mid-send returns still holding its answer. Each rewind starts a
  // new scope, so only the newest few settled ones are kept, and one is dropped once its delivery shows.
  const [operation, setOperation] = useNativeChatViewState<PromptAnswerOperation | null>(
    `async-answer:${sourceScope}`,
    null,
    KEPT_PROMPT_VIEWS
  )
  const queuedTexts = useMemo(() => queuedCards?.map((card) => card.text), [queuedCards])
  const { prompt, dismiss, ownerKey, answerPending } = useNativeChatAsyncQuestions({
    paneKey,
    sourceKey,
    sourceScope,
    viewKey: paneKey,
    messages: session.messages,
    settled: session.readPhase === 'ready' && !blocked,
    queuedTexts,
    skip
  })
  // A send's evidence is its own row or submission, never a streamed reply's text.
  const structure = projectionBesideStreamedText(session.messages)
  const operationPending = useMemo(
    () => nativeChatAnswerOperationPending(operation, structure, submissions),
    [operation, structure, submissions]
  )
  // Dropped only on proof the answer landed (a queue handoff can still bring a pending submission), or when the
  // send never created a message to wait on.
  const settled =
    operation !== null &&
    !operation.inFlight &&
    (operation.clientMessageId === undefined ||
      nativeChatAnswerOperationEvidence(operation.clientMessageId, structure, submissions) ===
        false)
  useEffect(() => {
    if (settled) {
      setOperation(null)
    }
  }, [settled, setOperation])
  if (!prompt) {
    return null
  }
  const promptKey = JSON.stringify([ownerKey, nativeChatAskDismissKey(prompt)])
  return (
    <NativeChatQuestionCard
      key={promptKey}
      prompt={prompt}
      memoryKey={`async-question:${promptKey}`}
      isSubmitting={answerPending || (operation?.promptKey === promptKey && operationPending)}
      onAnswer={(selections) => {
        const current: PromptAnswerOperation = { promptKey, inFlight: true }
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
      onCancel={dismiss}
    />
  )
}

function NativeChatHostAsyncQuestion({
  target,
  sessionId,
  ...props
}: Omit<React.ComponentProps<typeof NativeChatStructuredAsyncQuestion>, 'skip'> & {
  target: RuntimeClientTarget
  sessionId: string
}): React.JSX.Element | null {
  const skip = useStructuredAgentSessionAsyncQuestionSkip(target, sessionId)
  return <NativeChatStructuredAsyncQuestion {...props} skip={skip} />
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
    <NativeChatHostAsyncQuestion
      target={props.target}
      sessionId={sessionId}
      paneKey={chatPaneKey(sessionId)}
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
