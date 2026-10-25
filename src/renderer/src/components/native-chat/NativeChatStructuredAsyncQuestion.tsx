import { useMemo } from 'react'
import { extractPendingMessageReplyAsk, formatAskAnswer } from '../../../../shared/native-chat-ask'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { useNativeChatPromptCardPresentation } from './use-native-chat-prompt-card-presentation'

/**
 * A question the agent asked without waiting (Codex's async one), pending until the next user
 * message. It sits above the composer rather than in its place, since the agent keeps working:
 * it is answered by an ordinary send, and Cancel only hides it.
 */
export function NativeChatStructuredAsyncQuestion({
  paneKey,
  session,
  send
}: {
  paneKey: string
  session: Pick<NativeChatLiveSession, 'messages' | 'readPhase'>
  send: NativeChatStructuredComposerTransport['send']
}): React.JSX.Element | null {
  const settled = session.readPhase === 'ready'
  const pending = useMemo(() => {
    const prompt = settled ? extractPendingMessageReplyAsk(session.messages) : null
    return prompt ? { kind: 'question' as const, prompt } : null
  }, [session.messages, settled])
  const presentation = useNativeChatPromptCardPresentation({
    paneKey,
    card: pending,
    canSend: true,
    transcriptSettled: settled
  })
  const { card } = presentation
  if (card?.kind !== 'question') {
    return null
  }
  return (
    <NativeChatQuestionCard
      key={presentation.occurrenceKey ?? 'async-question'}
      prompt={card.prompt}
      onAnswer={(selections) => {
        if (send(formatAskAnswer(card.prompt, selections), []) !== false) {
          presentation.dismiss()
        }
      }}
      onCancel={presentation.dismiss}
    />
  )
}
