import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ExecutionHostScope } from '../../../shared/execution-host'
import type { ExecutionHostHealth } from '../../../shared/execution-host/execution-host-health'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import type { TaskProvider } from '../../../shared/work-items/task-providers'
import type { TaskProviderIdentity } from '../../../shared/work-items/task-provider-identity'
import type { TaskSourceContext } from '../../../shared/work-items/task-source-context'
import { getTranslatedExecutionHostLabel } from './sidebar/execution-host-label'
import {
  accountTitlePart,
  availabilityTitlePart,
  formatHostStatus,
  getAvailabilityLabel,
  getAvailabilityStatusLabel,
  hostTitlePart,
  projectCountLabel,
  selectedProjectCountLabel,
  sourceHostCountLabel
} from './task-source-host-status-labels'

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
  return hostLabelById?.get(hostId) ?? getTranslatedExecutionHostLabel(hostId)
}

type RepoBackedTaskSourceSummaryArgs = {
  providerLabel: string
  repoContexts: readonly TaskSourceContext[]
  /** Resolved list sources; null names no repository. Saved project identity is not the list's source. */
  repoIdentities: readonly (TaskProviderIdentity | null)[]
  hostAvailability?: readonly TaskSourceHostAvailability[]
  hostLabelById?: HostLabelLookup
  selectedRepoCount?: number
}

export function getTaskSourceContextSummary(
  args:
    | ({ provider: Extract<TaskProvider, 'github' | 'gitlab'> } & RepoBackedTaskSourceSummaryArgs)
    | {
        provider: Extract<TaskProvider, 'linear' | 'jira'>
        providerLabel: string
        hostAvailability?: readonly TaskSourceHostAvailability[]
        hostLabelById?: HostLabelLookup
        accountHostId?: ExecutionHostScope | null
        linearWorkspaceName?: string | null
        jiraSiteName?: string | null
      },
  t?: Translate
): TaskSourceContextSummary {
  switch (args.provider) {
    case 'github':
    case 'gitlab':
      return getRepoBackedTaskSourceSummary(args, t)
    case 'linear':
      return getAccountBackedTaskSourceSummary(
        args.providerLabel,
        {
          accountLabel: args.linearWorkspaceName,
          accountHostId: args.accountHostId,
          hostLabelById: args.hostLabelById,
          hostAvailability: args.hostAvailability
        },
        t
      )
    case 'jira':
      return getAccountBackedTaskSourceSummary(
        args.providerLabel,
        {
          accountLabel: args.jiraSiteName,
          accountHostId: args.accountHostId,
          hostLabelById: args.hostLabelById,
          hostAvailability: args.hostAvailability
        },
        t
      )
  }
}

export function getTaskSourceAvailabilityNotice(
  args: {
    providerLabel: string
    hostAvailability?: readonly TaskSourceHostAvailability[]
    hostLabelById?: HostLabelLookup
    sourceCount?: number
  },
  t: Translate = translate
): TaskSourceAvailabilityNotice | null {
  const unavailableHosts = getUnavailableHosts(args.hostAvailability ?? [], args.hostLabelById, t)
  if (unavailableHosts.length === 0) {
    return null
  }
  const sourceCount = Math.max(args.sourceCount ?? unavailableHosts.length, unavailableHosts.length)
  const blocking = unavailableHosts.length >= sourceCount
  const hostStatusLabels = unavailableHosts.map(formatHostStatus)
  const target =
    unavailableHosts.length === 1
      ? hostStatusLabels[0]
      : sourceHostCountLabel(unavailableHosts.length, t)
  return {
    label: blocking
      ? t(
          'auto.components.taskSourceContextSummary.sourceUnavailable',
          '{{value0}} source unavailable: {{value1}}',
          { value0: args.providerLabel, value1: target }
        )
      : t(
          'auto.components.taskSourceContextSummary.someSourceHostsUnavailable',
          'Some {{value0}} source hosts unavailable: {{value1}}',
          { value0: args.providerLabel, value1: target }
        ),
    title: t(
      'auto.components.taskSourceContextSummary.reconnectOrUpdateTitle',
      'Reconnect or update {{value0}} to load this source.',
      { value0: formatLongList(hostStatusLabels) }
    ),
    blocking
  }
}

function getRepoBackedTaskSourceSummary(
  args: RepoBackedTaskSourceSummaryArgs,
  t: Translate = translate
): TaskSourceContextSummary {
  const contexts = args.repoContexts
  const hostLabels = uniqueLabels(
    contexts.map((context) => getHostLabel(context.hostId, args.hostLabelById))
  )
  const unavailableHosts = getUnavailableHosts(args.hostAvailability ?? [], args.hostLabelById, t)
  const availabilityLabel = getAvailabilityLabel(unavailableHosts, t)
  const identityLabels = uniqueLabels(args.repoIdentities.map(getProviderIdentityLabel))
  const accountLabels = uniqueLabels(contexts.map((context) => context.accountLabel))
  const repoCount = args.selectedRepoCount ?? contexts.length
  const hostLabel =
    hostLabels.length === 0
      ? t('auto.components.taskSourceContextSummary.noHost', 'No host')
      : formatShortList(hostLabels)
  const accountLabel =
    accountLabels.length > 0 ? accountTitlePart(formatLongList(accountLabels), t) : null
  const targetLabel =
    accountLabels.length > 1
      ? formatShortList(accountLabels)
      : repoCount > 1
        ? projectCountLabel(repoCount, t)
        : (identityLabels[0] ??
          contexts[0]?.accountLabel ??
          t('auto.components.taskSourceContextSummary.selectedProject', 'Selected project'))
  const titleParts = [
    args.providerLabel,
    hostLabels.length > 0 ? hostTitlePart(formatLongList(hostLabels), t) : null,
    unavailableHosts.length > 0 ? availabilityTitlePart(unavailableHosts, t) : null,
    accountLabel,
    identityLabels.length > 0
      ? t('auto.components.taskSourceContextSummary.sourceTitle', 'Source: {{source}}', {
          source: formatLongList(identityLabels)
        })
      : null,
    repoCount > 1 ? selectedProjectCountLabel(repoCount, t) : null
  ].filter((part): part is string => Boolean(part))

  return {
    label: [args.providerLabel, hostLabel, availabilityLabel, targetLabel]
      .filter((part): part is string => Boolean(part))
      .join(' · '),
    title: titleParts.join(' · ')
  }
}

export function getAccountBackedTaskSourceSummary(
  providerLabel: string,
  args: {
    accountLabel: string | null | undefined
    accountHostId: ExecutionHostScope | null | undefined
    hostLabelById?: HostLabelLookup
    hostAvailability?: readonly TaskSourceHostAvailability[]
  },
  t: Translate = translate
): TaskSourceContextSummary {
  const target =
    args.accountLabel?.trim() ||
    t('auto.components.taskSourceContextSummary.currentAccount', 'Current account')
  const hostLabel = getHostLabel(args.accountHostId ?? 'local', args.hostLabelById)
  const unavailableHosts = getUnavailableHosts(args.hostAvailability ?? [], args.hostLabelById, t)
  const availabilityLabel = getAvailabilityLabel(unavailableHosts, t)
  const titleParts = [
    t('auto.components.taskSourceContextSummary.providerSourceTitle', '{{provider}} source', {
      provider: providerLabel
    }),
    hostTitlePart(hostLabel, t),
    availabilityLabel ? availabilityTitlePart(unavailableHosts, t) : null,
    accountTitlePart(target, t)
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
  hostLabelById?: HostLabelLookup,
  t?: Translate
): {
  hostLabel: string
  statusLabel: string
}[] {
  const seen = new Set<string>()
  const unavailableHosts: { hostLabel: string; statusLabel: string }[] = []
  for (const availability of hostAvailability) {
    const statusLabel = getAvailabilityStatusLabel(availability, t)
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

function formatShortList(labels: readonly string[]): string {
  if (labels.length <= 2) {
    return labels.join(', ')
  }
  return `${labels[0]} +${labels.length - 1}`
}

function formatLongList(labels: readonly string[]): string {
  return labels.join(', ')
}
