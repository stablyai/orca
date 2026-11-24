import { memo, useContext, useState } from 'react'
import { NativeChatAgentMessageCard } from '../messages/rows/NativeChatAgentMessageCard'
import { NativeChatWaitingAgentMailRowsContext } from './NativeChatWaitingAgentMailActions'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { OrchestrationSessionWorker } from '../../../../../shared/orchestration-session-workers'
import { agentMessageSessionWorker } from '../../../../../shared/agent-session/view/messages/agent-message-dispatch'
import { structuralValuesEqual } from '../../../../../shared/collections/structural-value-equality'
import { NativeChatWorkersContext, useNativeChatWorkers } from '../native-chat-workers-context'
import {
  useNativeChatWaitingRowHeight,
  useNativeChatWaitingRowShown
} from './native-chat-waiting-row-visibility'

const NO_REFOLD = (): void => {}
const NO_WORKERS: readonly OrchestrationSessionWorker[] = []

/** Other agents' waiting mail, after the conversation's live activity: it is not part of the turn.
 *  Memoized with no props, so a streaming update redraws it only when the mail or its actions change.
 *  Polite, as the queue it replaces was, and mounted while empty so the first arrival is announced. */
export const NativeChatWaitingAgentMailRows = memo(
  function NativeChatWaitingAgentMailRows(): React.JSX.Element | null {
    const rows = useContext(NativeChatWaitingAgentMailRowsContext)
    if (!rows) {
      return null
    }
    return (
      <div aria-live="polite" className="contents">
        {rows.map((message) => (
          <NativeChatWaitingAgentMailRow key={message.id} message={message} />
        ))}
      </div>
    )
  }
)

/** One waiting row. Far from view it keeps only its height and none of its card, so its sender's
 *  status, name and worker reach only rows near view. */
const NativeChatWaitingAgentMailRow = memo(function NativeChatWaitingAgentMailRow({
  message
}: {
  message: NativeChatMessage
}): React.JSX.Element | null {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const shown = useNativeChatWaitingRowShown(element)
  const height = useNativeChatWaitingRowHeight(element, shown)
  const held = !shown && height !== null
  if (!message.from) {
    return null
  }
  return (
    <div
      ref={setElement}
      data-native-chat-message-id={message.id}
      // A held row is empty, so in a flex column (setup mail block) it would shrink to nothing.
      className="shrink-0"
      style={held ? { height } : undefined}
    >
      {held ? null : <NativeChatWaitingAgentMailCard message={message} />}
    </div>
  )
})

/** The drawn card, handed only its own sender's worker, kept while that worker is unchanged, so
 *  neither a new arrival nor another worker's change redraws it. */
const NativeChatWaitingAgentMailCard = memo(function NativeChatWaitingAgentMailCard({
  message
}: {
  message: NativeChatMessage
}): React.JSX.Element | null {
  const worker = agentMessageSessionWorker(message, useNativeChatWorkers())
  const current = worker ? [worker] : NO_WORKERS
  const [own, setOwn] = useState(current)
  if (!structuralValuesEqual(own, current)) {
    setOwn(current)
  }
  return message.from ? (
    <NativeChatWorkersContext.Provider value={own}>
      <NativeChatAgentMessageCard message={message} from={message.from} onRefolded={NO_REFOLD} />
    </NativeChatWorkersContext.Provider>
  ) : null
})
