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
import { runZotzHostQueueAction } from './zotz-host-agent-queue-actions'
import { useZotzHostAgentQueue, useZotzHostQueueControllable } from './zotz-host-agent-queue-store'

/** A native chat whose agent waits in the memory queue says so above its composer (docs/zotz/PLAN.md §8g). */
export function ZotzQueuedChatNotice({
  sessionId,
  target
}: {
  sessionId: string
  /** Where the chat's agent runs; omitted or local reads this machine's queue. */
  target?: RuntimeClientTarget
}): React.JSX.Element | null {
  const environmentId = target?.kind === 'environment' ? target.environmentId : null
  const localSnapshot = useZotzAgentQueue()
  const remoteSnapshot = useZotzHostAgentQueue(
    environmentId ? toRuntimeExecutionHostId(environmentId) : null
  )
  const controllable = useZotzHostQueueControllable(environmentId)
  const hostLabel = useAppStore((state) =>
    environmentId
      ? selectExecutionHostDisplayLabel(state, toRuntimeExecutionHostId(environmentId))
      : undefined
  )
  const snapshot = environmentId ? remoteSnapshot : localSnapshot
  if (!snapshot) {
    return null
  }
  // Main keys the wait by the session's canonical tab, whichever tab shows it here.
  const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
  const task = snapshot.queued.find((entry) => entry.id === paneKey)
  if (!task) {
    return null
  }
  // A server's buttons appear only when it declares the control calls; the others stay a read-only notice.
  const queueAction = (action: 'cancel' | 'forceStart'): (() => void) | undefined => {
    if (!environmentId) {
      return () => void window.api.zotzAgentQueue[action](task.id)
    }
    return controllable
      ? () =>
          void runZotzHostQueueAction(environmentId, hostLabel ?? environmentId, action, task.id)
      : undefined
  }
  return (
    <div className="flex shrink-0 justify-center px-3 pb-2" data-zotz-queued-chat={task.position}>
      <ZotzQueuedPaneCard
        task={task}
        snapshot={snapshot}
        hostLabel={hostLabel}
        onCancel={queueAction('cancel')}
        onForceStart={queueAction('forceStart')}
      />
    </div>
  )
}
