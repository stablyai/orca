import { useAppStore } from '@/store/index'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import type { ZotzAgentQueueBoardProps } from './ZotzAgentQueueBoard'
import { ZotzAgentQueueMachineLane } from './ZotzAgentQueueMachineLane'
import { useZotzQueueOnHost } from './use-zotz-queue-on-host'
import { useZotzHostAgentQueues } from './zotz-host-agent-queue-store'

type LaneContext = Pick<ZotzAgentQueueBoardProps, 'now' | 'workspaceName' | 'onOpenPane'>

function MachineLane({
  hostId,
  environmentId,
  context
}: {
  hostId: ExecutionHostId
  environmentId: string | null
  context: LaneContext
}): React.JSX.Element | null {
  const { snapshot, hostLabel, act } = useZotzQueueOnHost(environmentId)
  const localLabel = useAppStore((state) =>
    environmentId ? null : selectExecutionHostDisplayLabel(state, LOCAL_EXECUTION_HOST_ID)
  )
  if (!snapshot) {
    return null
  }
  return (
    <ZotzAgentQueueMachineLane
      machine={{
        hostId,
        name: hostLabel ?? localLabel ?? hostId,
        isThisDevice: environmentId === null,
        snapshot,
        workspaceName: context.workspaceName,
        onCancel: act ? (id) => act('cancel', id) : undefined,
        onForceStart: act ? (id) => act('forceStart', id) : undefined
      }}
      now={context.now}
      onOpenPane={context.onOpenPane}
    />
  )
}

/** This machine first, then every paired server that publishes its queue. */
export function ZotzAgentQueueMachines(context: LaneContext): React.JSX.Element {
  const hostQueues = useZotzHostAgentQueues()
  const servers = [...hostQueues.keys()].flatMap((hostId) => {
    const parsed = parseExecutionHostId(hostId)
    return parsed?.kind === 'runtime' ? [{ hostId, environmentId: parsed.environmentId }] : []
  })
  return (
    <div className="scrollbar-sleek max-h-[70vh] space-y-2 overflow-y-auto">
      <MachineLane hostId={LOCAL_EXECUTION_HOST_ID} environmentId={null} context={context} />
      {servers.map((server) => (
        <MachineLane
          key={server.hostId}
          hostId={server.hostId}
          environmentId={server.environmentId}
          context={context}
        />
      ))}
    </div>
  )
}
