import { asyncQuestionSourceScope } from '../../../../shared/native-chat/input/native-chat-ask'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { structuredAgentSessionHostKey } from '../../runtime/structured-agent-session-host-capability'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import { nativeChatAskDismissKey } from '../../../../shared/native-chat-ask-dismiss-key'
import { formatAskAnswer } from '../../../../shared/native-chat-ask-answer'
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
  send
}: {
  paneKey: string
  sourceKey: string
  sourceScope: string
  blocked?: boolean
  session: Pick<NativeChatLiveSession, 'messages' | 'readPhase'>
  send: NativeChatStructuredComposerTransport['send']
}): React.JSX.Element | null {
  const { prompt, dismiss, ownerKey } = useNativeChatAsyncQuestions({
    paneKey,
    sourceKey,
    sourceScope,
    viewKey: paneKey,
    messages: session.messages,
    settled: session.readPhase === 'ready' && !blocked
  })
  if (!prompt) {
    return null
  }
  return (
    <NativeChatQuestionCard
      key={JSON.stringify([ownerKey, nativeChatAskDismissKey(prompt)])}
      prompt={prompt}
      onAnswer={(selections) => {
        // Send admission can precede delivery; canonical transcript rows retire questions.
        send(formatAskAnswer(prompt, selections), [])
      }}
      onCancel={dismiss}
    />
  )
}

export function nativeChatStructuredAsyncQuestion(
  props: Pick<NativeChatStructuredViewProps, 'target' | 'agent' | 'sessionId' | 'tabId'>,
  controller: Pick<ReturnType<typeof useStructuredAgentSession>, 'epoch' | 'prompts'>,
  session: Pick<NativeChatLiveSession, 'messages' | 'readPhase'>,
  send: NativeChatStructuredComposerTransport['send']
): React.JSX.Element {
  const { agent, sessionId } = props
  const { epoch } = controller
  return (
    <NativeChatStructuredAsyncQuestion
      paneKey={structuredAgentSessionPaneKey(props.tabId, sessionId)}
      session={session}
      send={send}
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
