import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { ZotzQueuedPaneCard } from './ZotzQueuedPanePortals'
import { useZotzAgentQueue } from './zotz-agent-queue-store'

/** A native chat whose agent waits in the memory queue says so above its composer (docs/zotz/PLAN.md §8g). */
export function ZotzQueuedChatNotice({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element | null {
  const snapshot = useZotzAgentQueue()
  // Main keys the wait by the session's canonical tab, whichever tab shows it here.
  const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
  const task = snapshot.queued.find((entry) => entry.id === paneKey)
  if (!task) {
    return null
  }
  return (
    <div className="flex shrink-0 justify-center px-3 pb-2" data-zotz-queued-chat={task.position}>
      <ZotzQueuedPaneCard
        task={task}
        snapshot={snapshot}
        onCancel={() => void window.api.zotzAgentQueue.cancel(task.id)}
        onForceStart={() => void window.api.zotzAgentQueue.forceStart(task.id)}
      />
    </div>
  )
}
