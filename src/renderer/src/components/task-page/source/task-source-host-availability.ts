import type { ExecutionHostRegistryEntry } from '../../../../../shared/execution-host-registry'
import { TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY } from '../../../../../shared/protocol-version'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { TaskSourceHostAvailability } from '../../task-source-context-summary'

export function getTaskSourceHostAvailabilityForHost(
  host: ExecutionHostRegistryEntry | null | undefined,
  hostId: TaskSourceContext['hostId']
): TaskSourceHostAvailability | null {
  if (!host) {
    return null
  }
  if (host.kind === 'runtime') {
    if (!host.capabilities) {
      return {
        hostId,
        reason: 'checking-task-source-capability'
      }
    }
    if (!host.capabilities.includes(TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY)) {
      return {
        hostId,
        reason: 'missing-task-source-capability'
      }
    }
  }
  if (host.health === 'local' || host.health === 'available') {
    return null
  }
  return {
    hostId,
    health: host.health,
    status: host.connectionStatus
  }
}
