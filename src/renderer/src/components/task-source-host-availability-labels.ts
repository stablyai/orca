import { translate } from '@/i18n/i18n'
import type { ExecutionHostScope } from '../../../shared/execution-host'
import { translateLocalExecutionHostLabel } from './sidebar/execution-host-label'
import { getTranslatedExecutionHostLabel } from './sidebar/host-section-rows'
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

export type UnavailableHostLabel = {
  hostLabel: string
  statusLabel: string
}

export function getHostLabel(hostId: ExecutionHostScope, hostLabelById: HostLabelLookup): string {
  const raw = hostLabelById?.get(hostId) ?? getTranslatedExecutionHostLabel(hostId)
  return translateLocalExecutionHostLabel(raw)
}

export function getUnavailableHosts(
  hostAvailability: readonly TaskSourceHostAvailability[],
  hostLabelById?: HostLabelLookup
): UnavailableHostLabel[] {
  const seen = new Set<string>()
  const unavailableHosts: UnavailableHostLabel[] = []
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

export function getAvailabilityLabel(
  unavailableHosts: readonly UnavailableHostLabel[]
): string | null {
  if (unavailableHosts.length === 0) {
    return null
  }
  if (unavailableHosts.length === 1) {
    return unavailableHosts[0].statusLabel
  }
  return translate(
    'auto.components.taskSourceContextSummary.unavailableCount',
    '{{count}} unavailable',
    {
      count: unavailableHosts.length
    }
  )
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

function getAvailabilityStatusLabel(availability: TaskSourceHostAvailability): string | null {
  switch (availability.reason) {
    case undefined:
      break
    case 'checking-task-source-capability':
      return translate(
        'auto.components.taskSourceContextSummary.checkingServerCapabilities',
        'checking server capabilities'
      )
    case 'missing-task-source-capability':
      return translate(
        'auto.components.taskSourceContextSummary.serverUpdateNeededForTaskSources',
        'server update needed for task sources'
      )
    case 'missing-provider-auth':
      return translate(
        'auto.components.taskSourceContextSummary.providerAuthNeeded',
        'provider auth needed'
      )
    case 'unavailable-source-tool':
      return translate(
        'auto.components.taskSourceContextSummary.sourceToolUnavailable',
        'source tool unavailable'
      )
    case 'unsupported-provider':
      return translate(
        'auto.components.taskSourceContextSummary.providerUnsupportedOnHost',
        'provider unsupported on this host'
      )
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
      return translate('auto.components.taskSourceContextSummary.connecting', 'connecting')
    case 'blocked':
      return translate(
        'auto.components.taskSourceContextSummary.serverUpdateNeeded',
        'server update needed'
      )
    case 'disconnected':
      return translate('auto.components.taskSourceContextSummary.disconnected', 'disconnected')
    case 'error':
      return translate(
        'auto.components.taskSourceContextSummary.connectionIssue',
        'connection issue'
      )
  }
}

function getSshStatusLabel(status: SshConnectionStatus): string {
  switch (status) {
    case 'connected':
      return translate('auto.components.taskSourceContextSummary.connected', 'connected')
    case 'connecting':
    case 'deploying-relay':
    case 'reconnecting':
      return translate('auto.components.taskSourceContextSummary.connecting', 'connecting')
    case 'auth-failed':
      return translate('auto.components.taskSourceContextSummary.authNeeded', 'auth needed')
    case 'reconnection-failed':
    case 'error':
      return translate(
        'auto.components.taskSourceContextSummary.connectionIssue',
        'connection issue'
      )
    case 'disconnected':
      return translate('auto.components.taskSourceContextSummary.disconnected', 'disconnected')
  }
}
