import { memo, useContext, useState } from 'react'
import { NativeChatAgentMessageCard } from '../messages/rows/NativeChatAgentMessageCard'
import { NativeChatWaitingAgentMailRowsContext } from './NativeChatWaitingAgentMailActions'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { OrchestrationSessionWorker } from '../../../../../shared/orchestration-session-workers'
import { agentMessageSessionWorker } from '../../../../../shared/agent-session/view/messages/agent-message-dispatch'
import { structuralValuesEqual } from '../../../../../shared/collections/structural-value-equality'
import { NativeChatWorkersContext, useNativeChatWorkers } from '../native-chat-workers-context'

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

/** One waiting row. It hands its card only its own sender's worker, kept while that worker is
 *  unchanged, so neither a new arrival nor another worker's change redraws the card. */
const NativeChatWaitingAgentMailRow = memo(function NativeChatWaitingAgentMailRow({
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
  return (
    <NativeChatWorkersContext.Provider value={own}>
      <NativeChatWaitingAgentMailCard message={message} />
    </NativeChatWorkersContext.Provider>
  )
})

const NativeChatWaitingAgentMailCard = memo(function NativeChatWaitingAgentMailCard({
  message
}: {
  message: NativeChatMessage
}): React.JSX.Element | null {
  if (!message.from) {
    return null
  }
  return (
    <div data-native-chat-message-id={message.id}>
      <NativeChatAgentMessageCard message={message} from={message.from} onRefolded={NO_REFOLD} />
    </div>
  )
})
