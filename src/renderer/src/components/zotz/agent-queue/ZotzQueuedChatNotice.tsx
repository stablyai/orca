import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { useAppStore } from '@/store/index'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { ZotzQueuedPaneCard } from './ZotzQueuedPanePortals'
import { useZotzAgentQueue } from './zotz-agent-queue-store'
import { useZotzHostAgentQueue } from './zotz-host-agent-queue-store'

/** A native chat whose agent waits in the memory queue says so above its composer (docs/zotz/PLAN.md §8g). */
export function ZotzQueuedChatNotice({
  sessionId,
  target
}: {
  sessionId: string
  /** Where the chat's agent runs; omitted or local reads this machine's queue. */
  target?: RuntimeClientTarget
}): React.JSX.Element | null {
  const localSnapshot = useZotzAgentQueue()
  const remoteSnapshot = useZotzHostAgentQueue(
    target?.kind === 'environment' ? toRuntimeExecutionHostId(target.environmentId) : null
  )
  const remote = target?.kind === 'environment'
  const hostLabel = useAppStore((state) =>
    target?.kind === 'environment'
      ? selectExecutionHostDisplayLabel(state, toRuntimeExecutionHostId(target.environmentId))
      : undefined
  )
  const snapshot = remote ? remoteSnapshot : localSnapshot
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
        onCancel={remote ? undefined : () => void window.api.zotzAgentQueue.cancel(task.id)}
        onForceStart={remote ? undefined : () => void window.api.zotzAgentQueue.forceStart(task.id)}
      />
    </div>
  )
}
