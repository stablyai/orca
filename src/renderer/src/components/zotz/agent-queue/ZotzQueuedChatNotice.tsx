import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { ZotzQueuedPaneCard } from './ZotzQueuedPanePortals'
import { useZotzQueueOnHost } from './use-zotz-queue-on-host'

/** A native chat whose agent waits in the memory queue says so above its composer (docs/zotz/PLAN.md §8g). */
export function ZotzQueuedChatNotice({
  sessionId,
  target
}: {
  sessionId: string
  /** Where the chat's agent runs; omitted or local reads this machine's queue. */
  target?: RuntimeClientTarget
}): React.JSX.Element | null {
  const { snapshot, hostLabel, act } = useZotzQueueOnHost(
    target?.kind === 'environment' ? target.environmentId : null
  )
  if (!snapshot) {
    return null
  }
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
        hostLabel={hostLabel}
        onCancel={act ? () => act('cancel', task.id) : undefined}
        onForceStart={act ? () => act('forceStart', task.id) : undefined}
      />
    </div>
  )
}
