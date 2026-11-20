import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../../shared/execution-host'
import type { ZotzAgentQueueMachine } from './ZotzAgentQueueBoard'
import { useZotzAgentQueue } from './zotz-agent-queue-store'
import { runZotzHostQueueAction } from './zotz-host-agent-queue-actions'
import {
  selectZotzHostQueueControllable,
  useZotzHostAgentQueues
} from './zotz-host-agent-queue-store'

/** This machine first, then every paired server that publishes its queue, each with the actions it accepts. */
export function useZotzAgentQueueMachines(): ZotzAgentQueueMachine[] {
  const localSnapshot = useZotzAgentQueue()
  const hostQueues = useZotzHostAgentQueues()
  const servers = [...hostQueues].flatMap(([hostId, snapshot]) => {
    const parsed = parseExecutionHostId(hostId)
    return parsed?.kind === 'runtime'
      ? [{ hostId: parsed.id, environmentId: parsed.environmentId, snapshot }]
      : []
  })
  const localName = useAppStore((state) =>
    selectExecutionHostDisplayLabel(state, LOCAL_EXECUTION_HOST_ID)
  )
  const serverNames = useAppStore(
    useShallow((state) =>
      servers.map((server) => selectExecutionHostDisplayLabel(state, server.hostId))
    )
  )
  const serverControllable = useAppStore(
    useShallow((state) =>
      servers.map((server) => selectZotzHostQueueControllable(state, server.environmentId))
    )
  )
  return [
    {
      hostId: LOCAL_EXECUTION_HOST_ID,
      name: localName,
      isThisDevice: true,
      snapshot: localSnapshot,
      onCancel: (id) => void window.api.zotzAgentQueue.cancel(id),
      onForceStart: (id) => void window.api.zotzAgentQueue.forceStart(id)
    },
    ...servers.map((server, index): ZotzAgentQueueMachine => {
      const name = serverNames[index] ?? server.environmentId
      const act = (action: 'cancel' | 'forceStart') => (id: string) =>
        void runZotzHostQueueAction(server.environmentId, name, action, id)
      return {
        hostId: server.hostId,
        name,
        isThisDevice: false,
        snapshot: server.snapshot,
        ...(serverControllable[index]
          ? { onCancel: act('cancel'), onForceStart: act('forceStart') }
          : {})
      }
    })
  ]
}
