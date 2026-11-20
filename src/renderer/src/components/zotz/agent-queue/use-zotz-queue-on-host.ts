import { useAppStore } from '@/store/index'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host'
import type { ZotzAgentQueueSnapshot } from '../../../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'
import { useZotzAgentQueue } from './zotz-agent-queue-store'
import { runZotzHostQueueAction, type ZotzHostQueueAction } from './zotz-host-agent-queue-actions'
import { useZotzHostAgentQueue, useZotzHostQueueControllable } from './zotz-host-agent-queue-store'

export type ZotzQueueOnHost = {
  snapshot: ZotzAgentQueueSnapshot | null
  /** The server's name; absent for this machine. */
  hostLabel?: string
  /** Absent when the server does not declare the control calls, so its waits stay read-only. */
  act?: (action: ZotzHostQueueAction, id: string) => void
}

/** The memory queue an agent waits in: this machine's, or the paired server's that runs it. */
export function useZotzQueueOnHost(environmentId: string | null): ZotzQueueOnHost {
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
  if (!environmentId) {
    return {
      snapshot: localSnapshot,
      act: (action, id) => void window.api.zotzAgentQueue[action](id)
    }
  }
  return {
    snapshot: remoteSnapshot,
    hostLabel,
    act: controllable
      ? (action, id) =>
          void runZotzHostQueueAction(environmentId, hostLabel ?? environmentId, action, id)
      : undefined
  }
}
