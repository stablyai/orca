import { translate } from '@/i18n/i18n'
import { getExecutionHostLabel } from '../../../shared/execution-host'
import type { ExecutionHostScope } from '../../../shared/execution-host'
import type { ExecutionHostHealth } from '../../../shared/execution-host-registry'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import type { TaskProvider } from '../../../shared/types'
import type { TaskProviderIdentity, TaskSourceContext } from '../../../shared/task-source-context'

export type TaskSourceContextSummary = {
  label: string
  title: string
}

export type TaskSourceAvailabilityNotice = {
  label: string
  title: string
  blocking: boolean
}

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

type HostLabelLookup = ReadonlyMap<string, string> | undefined

function getHostLabel(hostId: ExecutionHostScope, hostLabelById: HostLabelLookup): string {
  return hostLabelById?.get(hostId) ?? getExecutionHostLabel(hostId)
}

export function getTaskSourceContextSummary(args: {
  provider: TaskProvider
  providerLabel: string
  repoContexts?: readonly TaskSourceContext[]
  hostAvailability?: readonly TaskSourceHostAvailability[]
  hostLabelById?: HostLabelLookup
  accountHostId?: ExecutionHostScope | null
  selectedRepoCount?: number
  linearWorkspaceName?: string | null
  jiraSiteName?: string | null
}): TaskSourceContextSummary {
  switch (args.provider) {
    case 'github':
    case 'gitlab':
      return getRepoBackedTaskSourceSummary(args)
    case 'linear':
      return getAccountBackedTaskSourceSummary(args.providerLabel, {
        accountLabel: args.linearWorkspaceName,
        accountHostId: args.accountHostId,
        hostLabelById: args.hostLabelById,
        hostAvailability: args.hostAvailability
      })
    case 'jira':
      return getAccountBackedTaskSourceSummary(args.providerLabel, {
        accountLabel: args.jiraSiteName,
        accountHostId: args.accountHostId,
        hostLabelById: args.hostLabelById,
        hostAvailability: args.hostAvailability
      })
    case 'trello':
      return getAccountBackedTaskSourceSummary(args.providerLabel, {
        accountLabel: undefined,
        accountHostId: args.accountHostId,
        hostLabelById: args.hostLabelById,
        hostAvailability: args.hostAvailability
      })
  }
}

export function getTaskSourceAvailabilityNotice(args: {
  providerLabel: string
  hostAvailability?: readonly TaskSourceHostAvailability[]
  hostLabelById?: HostLabelLookup
  sourceCount?: number
}): TaskSourceAvailabilityNotice | null {
  const unavailableHosts = getUnavailableHosts(args.hostAvailability ?? [], args.hostLabelById)
  if (unavailableHosts.length === 0) {
    return null
  }
  const sourceCount = Math.max(args.sourceCount ?? unavailableHosts.length, unavailableHosts.length)
  const blocking = unavailableHosts.length >= sourceCount
  const hostStatusLabels = unavailableHosts.map((host) => `${host.hostLabel} ${host.statusLabel}`)
  const target =
    unavailableHosts.length === 1 ? hostStatusLabels[0] : `${unavailableHosts.length} source hosts`
  return {
    label: blocking
      ? translate(
          'auto.components.taskSourceContextSummary.sourceUnavailable',
          '{{value0}} source unavailable: {{value1}}',
          { value0: args.providerLabel, value1: target }
        )
      : translate(
          'auto.components.taskSourceContextSummary.someSourceHostsUnavailable',
          'Some {{value0}} source hosts unavailable: {{value1}}',
          { value0: args.providerLabel, value1: target }
        ),
    title: translate(
      'auto.components.taskSourceContextSummary.reconnectOrUpdateTitle',
      'Reconnect or update {{value0}} to load this source.',
      { value0: formatLongList(hostStatusLabels) }
    ),
    blocking
  }
}

function getRepoBackedTaskSourceSummary(args: {
  providerLabel: string
  repoContexts?: readonly TaskSourceContext[]
  hostAvailability?: readonly TaskSourceHostAvailability[]
  hostLabelById?: HostLabelLookup
  selectedRepoCount?: number
}): TaskSourceContextSummary {
  const contexts = args.repoContexts ?? []
  const hostLabels = uniqueLabels(
    contexts.map((context) => getHostLabel(context.hostId, args.hostLabelById))
  )
  const unavailableHosts = getUnavailableHosts(args.hostAvailability ?? [], args.hostLabelById)
  const availabilityLabel = getAvailabilityLabel(unavailableHosts)
  const identityLabels = uniqueLabels(
    contexts.map((context) => getProviderIdentityLabel(context.providerIdentity))
  )
  const accountLabels = uniqueLabels(contexts.map((context) => context.accountLabel))
  const repoCount = args.selectedRepoCount ?? contexts.length
  const hostLabel = hostLabels.length === 0 ? 'No host' : formatShortList(hostLabels)
  const accountLabel = accountLabels.length > 0 ? `Account: ${formatLongList(accountLabels)}` : null
  const targetLabel =
    accountLabels.length > 1
      ? formatShortList(accountLabels)
      : repoCount > 1
        ? `${repoCount} projects`
        : (identityLabels[0] ?? contexts[0]?.accountLabel ?? 'Selected project')
  const titleParts = [
    args.providerLabel,
    hostLabels.length > 0 ? `Host: ${formatLongList(hostLabels)}` : null,
    unavailableHosts.length > 0
      ? `Availability: ${formatLongList(
          unavailableHosts.map((host) => `${host.hostLabel} ${host.statusLabel}`)
        )}`
      : null,
    accountLabel,
    identityLabels.length > 0 ? `Source: ${formatLongList(identityLabels)}` : null,
    repoCount > 1 ? `${repoCount} selected projects` : null
  ].filter((part): part is string => Boolean(part))

  return {
    label: [args.providerLabel, hostLabel, availabilityLabel, targetLabel]
      .filter((part): part is string => Boolean(part))
      .join(' · '),
    title: titleParts.join(' · ')
  }
}

function getAccountBackedTaskSourceSummary(
  providerLabel: string,
  args: {
    accountLabel: string | null | undefined
    accountHostId: ExecutionHostScope | null | undefined
    hostLabelById?: HostLabelLookup
    hostAvailability?: readonly TaskSourceHostAvailability[]
  }
): TaskSourceContextSummary {
  const target = args.accountLabel?.trim() || 'Current account'
  const hostLabel = getHostLabel(args.accountHostId ?? 'local', args.hostLabelById)
  const unavailableHosts = getUnavailableHosts(args.hostAvailability ?? [], args.hostLabelById)
  const availabilityLabel = getAvailabilityLabel(unavailableHosts)
  const titleParts = [
    `${providerLabel} source`,
    `Host: ${hostLabel}`,
    availabilityLabel
      ? `Availability: ${formatLongList(
          unavailableHosts.map((host) => `${host.hostLabel} ${host.statusLabel}`)
        )}`
      : null,
    `Account: ${target}`
  ].filter((part): part is string => Boolean(part))
  return {
    label: [providerLabel, hostLabel, availabilityLabel, target]
      .filter((part): part is string => Boolean(part))
      .join(' · '),
    title: titleParts.join(' · ')
  }
}

function getProviderIdentityLabel(
  identity: TaskProviderIdentity | null | undefined
): string | null {
  if (!identity) {
    return null
  }
  switch (identity.provider) {
    case 'github':
      return `${identity.owner}/${identity.repo}`
    case 'gitlab':
      return identity.namespace && identity.project
        ? `${identity.namespace}/${identity.project}`
        : (identity.projectId ?? null)
    case 'linear':
      return identity.workspaceName ?? identity.workspaceId ?? null
    case 'jira':
      return identity.siteUrl ?? identity.siteId ?? null
  }
}

function uniqueLabels(labels: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const label of labels) {
    const trimmed = label?.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function getUnavailableHosts(
  hostAvailability: readonly TaskSourceHostAvailability[],
  hostLabelById?: HostLabelLookup
): { hostLabel: string; statusLabel: string }[] {
  const seen = new Set<string>()
  const result: { hostLabel: string; statusLabel: string }[] = []
  for (const a of hostAvailability) {
    const statusLabel = getAvailabilityStatusLabel(a)
    if (!statusLabel) {
      continue
    }
    const hostLabel = getHostLabel(a.hostId, hostLabelById)
    const key = `${hostLabel}\u0000${statusLabel}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push({ hostLabel, statusLabel })
  }
  return result
}

function getAvailabilityStatusLabel(availability: TaskSourceHostAvailability): string | null {
  const reasonMap: Record<string, string> = {
    'checking-task-source-capability': 'checking server capabilities',
    'missing-task-source-capability': 'server update needed for task sources',
    'missing-provider-auth': 'provider auth needed',
    'unavailable-source-tool': 'source tool unavailable',
    'unsupported-provider': 'provider unsupported on this host'
  }
  if (availability.reason && availability.reason in reasonMap) {
    return reasonMap[availability.reason]
  }
  if (availability.status) {
    return availability.status === 'connected' ? null : getSshStatusLabel(availability.status)
  }
  const healthMap: Record<string, string | null> = {
    local: null,
    available: null,
    connecting: 'connecting',
    blocked: 'server update needed',
    disconnected: 'disconnected',
    error: 'connection issue'
  }
  return availability.health ? (healthMap[availability.health] ?? null) : null
}

function getAvailabilityLabel(
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

function getSshStatusLabel(status: SshConnectionStatus): string {
  const map: Record<SshConnectionStatus, string> = {
    connected: 'connected',
    connecting: 'connecting',
    'deploying-relay': 'connecting',
    reconnecting: 'connecting',
    'auth-failed': 'auth needed',
    'reconnection-failed': 'connection issue',
    error: 'connection issue',
    disconnected: 'disconnected'
  }
  return map[status]
}

function formatShortList(labels: readonly string[]): string {
  return labels.length <= 2 ? labels.join(', ') : `${labels[0]} +${labels.length - 1}`
}

function formatLongList(labels: readonly string[]): string {
  return labels.join(', ')
}
