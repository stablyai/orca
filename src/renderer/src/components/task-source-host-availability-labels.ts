import { getExecutionHostLabel } from '../../../shared/execution-host'
import type { ExecutionHostScope } from '../../../shared/execution-host'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import type { TaskSourceHostAvailability } from './task-source-context-summary'

type HostLabelLookup = ReadonlyMap<string, string> | undefined

export type UnavailableTaskSourceHost = {
  hostLabel: string
  statusLabel: string
}

function hostLabel(hostId: ExecutionHostScope, hostLabelById: HostLabelLookup): string {
  return hostLabelById?.get(hostId) ?? getExecutionHostLabel(hostId)
}

export function listUnavailableTaskSourceHosts(
  hostAvailability: readonly TaskSourceHostAvailability[],
  hostLabelById?: HostLabelLookup
): UnavailableTaskSourceHost[] {
  const seen = new Set<string>()
  const unavailableHosts: UnavailableTaskSourceHost[] = []
  for (const availability of hostAvailability) {
    const statusLabel = getAvailabilityStatusLabel(availability)
    if (!statusLabel) {
      continue
    }
    const label = hostLabel(availability.hostId, hostLabelById)
    const key = `${label}\u0000${statusLabel}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unavailableHosts.push({ hostLabel: label, statusLabel })
  }
  return unavailableHosts
}

export function getUnavailableTaskSourceLabel(
  unavailableHosts: readonly UnavailableTaskSourceHost[]
): string | null {
  if (unavailableHosts.length === 0) {
    return null
  }
  if (unavailableHosts.length === 1) {
    return unavailableHosts[0].statusLabel
  }
  return `${unavailableHosts.length} unavailable`
}

function getAvailabilityStatusLabel(availability: TaskSourceHostAvailability): string | null {
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

function getSshStatusLabel(status: SshConnectionStatus): string {
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
