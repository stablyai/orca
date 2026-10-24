import {
  NativeChatViewIdentity,
  createNativeChatReturnField,
  useNativeChatReturnRef,
  retireNativeChatViewState
} from './native-chat-view-state-memory'
import { useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  extractPendingMessageReplyAskState,
  formatAskAnswer
} from '../../../../shared/native-chat-ask'
import { compareAgentJournalPositions } from '../../../../shared/agent-session-journal-position'
import type { AgentJournalPosition } from '../../../../shared/agent-session-journal-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

type QuestionRecord = {
  epoch: string | null
  identity: string
  after: AgentJournalPosition | undefined
  scope: string | null
  dismissed: boolean
}
const currentQuestion = createNativeChatReturnField<QuestionRecord | null>()

/** Async questions are answered by ordinary messages; Cancel only hides this occurrence. */
export function NativeChatStructuredAsyncQuestion({
  session,
  send,
  epoch = null
}: {
  session: Pick<NativeChatLiveSession, 'messages' | 'readPhase'>
  send: NativeChatStructuredComposerTransport['send']
  epoch?: string | null
}): React.JSX.Element | null {
  const view = useContext(NativeChatViewIdentity)
  const cell = useNativeChatReturnRef(currentQuestion, () => null)
  const [held, setHeld] = useState(cell.current)
  const settled = session.readPhase === 'ready'
  const scan = useMemo(
    () => (settled ? extractPendingMessageReplyAskState(session.messages) : null),
    [session.messages, settled]
  )
  const prompt = scan?.replyAsMessage ?? null
  const identity = prompt ? JSON.stringify([scan?.contributions, prompt]) : null
  const replaced = held && epoch !== null && held.epoch !== null && epoch !== held.epoch
  const resolved =
    held?.after && scan?.clearedAt && compareAgentJournalPositions(scan.clearedAt, held.after) > 0
  let current = replaced || resolved ? null : held
  if (identity !== null && (current === null || current.identity !== identity)) {
    current = {
      epoch: epoch ?? held?.epoch ?? null,
      identity,
      after: scan?.contributionAt,
      scope: view === null ? null : `${view}\0async-question:${JSON.stringify([epoch, identity])}`,
      dismissed: false
    }
  } else if (current && epoch !== null && current.epoch === null) {
    current = { ...current, epoch }
  }
  if (current !== held) {
    setHeld(current)
  }
  const committed = useRef<QuestionRecord | null>(null)
  useLayoutEffect(() => {
    const previous = cell.current
    if (previous?.scope && previous.scope !== held?.scope) {
      retireNativeChatViewState(previous.scope)
    }
    if (!cell.retired) {
      cell.current = held
    }
    committed.current = prompt ? held : null
    return () => {
      committed.current = null
    }
  }, [cell, held, prompt])
  const isCurrent = () => held !== null && !cell.retired && committed.current === held
  const dismiss = () => {
    if (isCurrent()) {
      setHeld((value) => (value !== null && value === held ? { ...value, dismissed: true } : value))
    }
  }
  if (!prompt || !held || held.dismissed) {
    return null
  }
  return (
    <NativeChatViewIdentity.Provider value={held.scope}>
      <NativeChatQuestionCard
        key={held.scope ?? held.identity}
        prompt={prompt}
        onAnswer={(selections) => {
          if (isCurrent() && send(formatAskAnswer(prompt, selections), []) !== false) {
            dismiss()
          }
        }}
        onCancel={dismiss}
      />
    </NativeChatViewIdentity.Provider>
  )
}
