import { translate } from '@/i18n/i18n'
import type { ExecutionHostScope } from '../../../shared/execution-host'
import type { TaskProvider } from '../../../shared/types'
import type { TaskProviderIdentity, TaskSourceContext } from '../../../shared/task-source-context'
import {
  formatLongList,
  formatShortList,
  getAvailabilityLabel,
  getHostLabel,
  getUnavailableHosts,
  type HostLabelLookup,
  type TaskSourceHostAvailability
} from './task-source-host-availability-labels'

export type { TaskSourceHostAvailability } from './task-source-host-availability-labels'

export type TaskSourceContextSummary = {
  label: string
  title: string
}

export type TaskSourceAvailabilityNotice = {
  label: string
  title: string
  blocking: boolean
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
    unavailableHosts.length === 1
      ? hostStatusLabels[0]
      : translate(
          'auto.components.taskSourceContextSummary.sourceHostsCount',
          '{{count}} source hosts',
          { count: unavailableHosts.length }
        )
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
  const hostLabel =
    hostLabels.length === 0
      ? translate('auto.components.taskSourceContextSummary.noHost', 'No host')
      : formatShortList(hostLabels)
  const accountLabel =
    accountLabels.length > 0
      ? translate('auto.components.taskSourceContextSummary.accountPrefix', 'Account: {{value0}}', {
          value0: formatLongList(accountLabels)
        })
      : null
  const targetLabel =
    accountLabels.length > 1
      ? formatShortList(accountLabels)
      : repoCount > 1
        ? translate(
            'auto.components.taskSourceContextSummary.projectsCount',
            '{{count}} projects',
            {
              count: repoCount
            }
          )
        : (identityLabels[0] ??
          contexts[0]?.accountLabel ??
          translate('auto.components.taskSourceContextSummary.selectedProject', 'Selected project'))
  const titleParts = [
    args.providerLabel,
    hostLabels.length > 0
      ? translate('auto.components.taskSourceContextSummary.hostPrefix', 'Host: {{value0}}', {
          value0: formatLongList(hostLabels)
        })
      : null,
    unavailableHosts.length > 0
      ? translate(
          'auto.components.taskSourceContextSummary.availabilityPrefix',
          'Availability: {{value0}}',
          {
            value0: formatLongList(
              unavailableHosts.map((host) => `${host.hostLabel} ${host.statusLabel}`)
            )
          }
        )
      : null,
    accountLabel,
    identityLabels.length > 0
      ? translate('auto.components.taskSourceContextSummary.sourcePrefix', 'Source: {{value0}}', {
          value0: formatLongList(identityLabels)
        })
      : null,
    repoCount > 1
      ? translate(
          'auto.components.taskSourceContextSummary.selectedProjectsCount',
          '{{count}} selected projects',
          { count: repoCount }
        )
      : null
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
  const target =
    args.accountLabel?.trim() ||
    translate('auto.components.taskSourceContextSummary.currentAccount', 'Current account')
  const hostLabel = getHostLabel(args.accountHostId ?? 'local', args.hostLabelById)
  const unavailableHosts = getUnavailableHosts(args.hostAvailability ?? [], args.hostLabelById)
  const availabilityLabel = getAvailabilityLabel(unavailableHosts)
  const titleParts = [
    translate('auto.components.taskSourceContextSummary.providerSource', '{{value0}} source', {
      value0: providerLabel
    }),
    translate('auto.components.taskSourceContextSummary.hostPrefix', 'Host: {{value0}}', {
      value0: hostLabel
    }),
    availabilityLabel
      ? translate(
          'auto.components.taskSourceContextSummary.availabilityPrefix',
          'Availability: {{value0}}',
          {
            value0: formatLongList(
              unavailableHosts.map((host) => `${host.hostLabel} ${host.statusLabel}`)
            )
          }
        )
      : null,
    translate('auto.components.taskSourceContextSummary.accountPrefix', 'Account: {{value0}}', {
      value0: target
    })
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
