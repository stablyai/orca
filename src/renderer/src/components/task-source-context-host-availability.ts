import { getExecutionHostLabel } from '../../../shared/execution-host'
import type { ExecutionHostScope } from '../../../shared/execution-host'
import type { ExecutionHostHealth } from '../../../shared/execution-host-registry'
import type { SshConnectionStatus } from '../../../shared/ssh-types'

export type TaskSourceHostAvailability = {
  hostId: ExecutionHostScope
  status?: SshConnectionStatus
  health?: ExecutionHostHealth
  reason?:
    | 'checking-task-source-capability'
    | 'missing-task-source-capability'
    | 'missing-provider-auth'
    | 'unavailable-source-tool'
    | 'unsupported-provider'
}

export type HostLabelLookup = ReadonlyMap<string, string> | undefined

export function getHostLabel(hostId: ExecutionHostScope, hostLabelById: HostLabelLookup): string {
  return hostLabelById?.get(hostId) ?? getExecutionHostLabel(hostId)
}

export function getUnavailableHosts(
  hostAvailability: readonly TaskSourceHostAvailability[],
  hostLabelById?: HostLabelLookup
): {
  hostLabel: string
  statusLabel: string
}[] {
  const seen = new Set<string>()
  const unavailableHosts: { hostLabel: string; statusLabel: string }[] = []
  for (const availability of hostAvailability) {
    const statusLabel = getAvailabilityStatusLabel(availability)
    if (!statusLabel) {
      continue
    }
    const hostLabel = getHostLabel(availability.hostId, hostLabelById)
    const key = `${hostLabel}\u0000${statusLabel}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unavailableHosts.push({ hostLabel, statusLabel })
  }
  return unavailableHosts
}

export function getAvailabilityStatusLabel(
  availability: TaskSourceHostAvailability
): string | null {
  switch (availability.reason) {
    case undefined:
      break
    case 'checking-task-source-capability':
      return 'checking server capabilities'
    case 'missing-task-source-capability':
      return 'server update needed for task sources'
    case 'missing-provider-auth':
      return 'provider auth needed'
    case 'unavailable-source-tool':
      return 'source tool unavailable'
    case 'unsupported-provider':
      return 'provider unsupported on this host'
  }
  if (availability.status) {
    return availability.status === 'connected' ? null : getSshStatusLabel(availability.status)
  }
  switch (availability.health) {
    case 'local':
    case 'available':
    case undefined:
      return null
    case 'connecting':
      return 'connecting'
    case 'blocked':
      return 'server update needed'
    case 'disconnected':
      return 'disconnected'
    case 'error':
      return 'connection issue'
  }
}

export function getAvailabilityLabel(
  unavailableHosts: readonly { hostLabel: string; statusLabel: string }[]
): string | null {
  if (unavailableHosts.length === 0) {
    return null
  }
  if (unavailableHosts.length === 1) {
    return unavailableHosts[0].statusLabel
  }
  return `${unavailableHosts.length} unavailable`
}

export function getSshStatusLabel(status: SshConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'connected'
    case 'connecting':
    case 'deploying-relay':
    case 'reconnecting':
      return 'connecting'
    case 'auth-failed':
      return 'auth needed'
    case 'reconnection-failed':
    case 'error':
      return 'connection issue'
    case 'disconnected':
      return 'disconnected'
  }
}

export function formatShortList(labels: readonly string[]): string {
  if (labels.length <= 2) {
    return labels.join(', ')
  }
  return `${labels[0]} +${labels.length - 1}`
}

export function formatLongList(labels: readonly string[]): string {
  return labels.join(', ')
}
