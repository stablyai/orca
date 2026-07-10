import { parseExecutionHostId } from '../../../shared/execution-host'
import type { TaskProvider } from '../../../shared/types'
import type { PreflightStatus } from '../../../preload/api-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { TaskSourceHostAvailability } from './task-source-context-summary'

type ProviderToolStatus = {
  installed: boolean
  authenticated: boolean
}

type ProviderAvailabilityStatus = ProviderToolStatus | 'unsupported'

export type RuntimeProviderPreflightStatus = {
  checked: boolean
  status: PreflightStatus | null
}

function isDesktopOwnedHost(hostId: TaskSourceContext['hostId']): boolean {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind !== 'runtime'
}

function getRepoBackedProviderToolStatus(
  provider: Extract<TaskProvider, 'github' | 'gitlab'>,
  preflightStatus: PreflightStatus | null
): ProviderAvailabilityStatus | null {
  if (!preflightStatus) {
    return null
  }
  if (provider === 'github') {
    return preflightStatus.gh
  }
  // Why: older remote servers can predate GitLab preflight entirely. That is a
  // host capability gap, not a user-fixable missing `glab` install.
  return Object.hasOwn(preflightStatus, 'glab')
    ? (preflightStatus.glab ?? { installed: false, authenticated: false })
    : 'unsupported'
}

function getProviderReason(
  status: ProviderAvailabilityStatus
): TaskSourceHostAvailability['reason'] | null {
  if (status === 'unsupported') {
    return 'unsupported-provider'
  }
  if (!status.installed) {
    return 'unavailable-source-tool'
  }
  if (!status.authenticated) {
    return 'missing-provider-auth'
  }
  return null
}

export function getRepoBackedProviderAvailability(args: {
  provider: Extract<TaskProvider, 'github' | 'gitlab'>
  contexts: readonly TaskSourceContext[]
  preflightStatus: PreflightStatus | null
  preflightReady: boolean
  runtimePreflightStatusByHostId?: ReadonlyMap<
    TaskSourceContext['hostId'],
    RuntimeProviderPreflightStatus
  >
}): TaskSourceHostAvailability[] {
  return args.contexts.flatMap((context) => {
    const hostPreflight = isDesktopOwnedHost(context.hostId)
      ? { checked: args.preflightReady, status: args.preflightStatus }
      : args.runtimePreflightStatusByHostId?.get(context.hostId)
    if (!hostPreflight?.checked) {
      return []
    }
    const status = getRepoBackedProviderToolStatus(args.provider, hostPreflight.status)
    const reason = status ? getProviderReason(status) : null
    return reason ? [{ hostId: context.hostId, reason }] : []
  })
}
