import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { PreflightStatus } from '../../../../preload/api/preflight/preflight-api'
import type { TaskProvider } from '../../../../shared/work-items/task-providers'
import type { TaskSourceContext } from '../../../../shared/work-items/task-source-context'
import type { RuntimeProviderPreflightStatus } from './source-selection/task-source-provider-availability'

export type ProviderPreflightRefreshTargets = {
  desktop: boolean
  runtimeHostIds: readonly TaskSourceContext['hostId'][]
}

function toolIsUnavailable(taskSource: TaskProvider, status: PreflightStatus | null): boolean {
  if (!status) {
    return false
  }
  const tool =
    taskSource === 'github' ? status.gh : taskSource === 'gitlab' ? status.glab : undefined
  return tool !== undefined && (!tool.installed || !tool.authenticated)
}

export function selectProviderPreflightRefreshTargets(args: {
  taskSource: TaskProvider
  contexts: readonly TaskSourceContext[]
  preflightStatus: PreflightStatus | null
  preflightStatusChecked: boolean
  preflightStatusCurrent: boolean
  preflightDescribesDesktop: boolean
  /** A failed desktop request leaves the last status stale and must be retried on the next open. */
  desktopPreflightFailed: boolean
  runtimePreflightStatusByHostId: ReadonlyMap<
    TaskSourceContext['hostId'],
    RuntimeProviderPreflightStatus
  >
}): ProviderPreflightRefreshTargets {
  if (args.taskSource !== 'github' && args.taskSource !== 'gitlab') {
    return { desktop: false, runtimeHostIds: [] }
  }

  let desktop = false
  const runtimeHostIds = new Set<TaskSourceContext['hostId']>()

  for (const context of args.contexts) {
    const parsed = parseExecutionHostId(context.hostId)
    if (parsed?.kind !== 'runtime') {
      if (
        args.preflightStatusCurrent &&
        args.preflightStatusChecked &&
        args.preflightDescribesDesktop &&
        (args.desktopPreflightFailed || toolIsUnavailable(args.taskSource, args.preflightStatus))
      ) {
        desktop = true
      }
      continue
    }

    const hostStatus = args.runtimePreflightStatusByHostId.get(context.hostId)
    if (hostStatus?.checked && toolIsUnavailable(args.taskSource, hostStatus.status)) {
      runtimeHostIds.add(context.hostId)
    }
  }

  return { desktop, runtimeHostIds: [...runtimeHostIds] }
}
