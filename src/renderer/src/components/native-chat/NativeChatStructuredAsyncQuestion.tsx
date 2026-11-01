import { asyncQuestionSourceScope } from '../../../../shared/native-chat/input/native-chat-ask'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { structuredAgentSessionHostKey } from '../../runtime/structured-agent-session-host-capability'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import { nativeChatAskDismissKey } from '../../../../shared/native-chat-ask-dismiss-key'
import { useMemo, useState } from 'react'
import type { QueuedMessageCard } from '../../../../shared/structured-agent-session-queued-cards'
import { formatAskAnswer } from '../../../../shared/native-chat-ask-answer'
import { nativeChatAnswerSendIntent } from '../../../../shared/native-chat-follow-up-behavior'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { useNativeChatAsyncQuestions } from './use-native-chat-async-questions'

/** Async questions leave the composer usable; the next ordinary send answers them and Cancel only hides them. */
export function NativeChatStructuredAsyncQuestion({
  paneKey,
  session,
  sourceKey,
  sourceScope,
  blocked = false,
  send,
  sendFollowUp,
  queuedCards
}: {
  paneKey: string
  sourceKey: string
  sourceScope: string
  blocked?: boolean
  session: Pick<NativeChatLiveSession, 'messages' | 'readPhase'>
  send: NativeChatStructuredComposerTransport['send']
  sendFollowUp?: NativeChatStructuredComposerTransport['sendFollowUp']
  queuedCards?: readonly Pick<QueuedMessageCard, 'text'>[]
}): React.JSX.Element | null {
  const [submitting, setSubmitting] = useState(false)
  const queuedTexts = useMemo(() => queuedCards?.map((card) => card.text), [queuedCards])
  const { prompt, dismiss, ownerKey } = useNativeChatAsyncQuestions({
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
    <NativeChatQuestionCard
      key={JSON.stringify([ownerKey, nativeChatAskDismissKey(prompt)])}
      prompt={prompt}
      isSubmitting={submitting}
      onAnswer={(selections) => {
        // Delivered rows retire questions, and a queued answer holds them; this only blocks resubmits until settled.
        // The card keeps a returned answer's question, so the text never lands in the composer draft.
        const sent = send(formatAskAnswer(prompt, selections), [], {
          ...nativeChatAnswerSendIntent(sendFollowUp),
          callerKeepsText: true,
          onSettled: () => setSubmitting(false)
        })
        if (sent) {
          setSubmitting(true)
        }
      }}
      onCancel={dismiss}
    />
  )
}

export function nativeChatStructuredAsyncQuestion(
  props: Pick<NativeChatStructuredViewProps, 'target' | 'agent' | 'sessionId' | 'tabId'>,
  controller: Pick<ReturnType<typeof useStructuredAgentSession>, 'epoch' | 'prompts'>,
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
