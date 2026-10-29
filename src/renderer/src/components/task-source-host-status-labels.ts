import { translate } from '@/i18n/i18n'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import type { TaskSourceHostAvailability } from './task-source-context-summary'

export function getAvailabilityStatusLabel(
  availability: TaskSourceHostAvailability
): string | null {
  switch (availability.reason) {
    case undefined:
      break
    case 'checking-task-source-capability':
      return translate(
        'auto.components.taskSourceContextSummary.statusCheckingCapabilities',
        'checking server capabilities'
      )
    case 'missing-task-source-capability':
      return translate(
        'auto.components.taskSourceContextSummary.statusServerUpdateForTaskSources',
        'server update needed for task sources'
      )
    case 'missing-provider-auth':
      return translate(
        'auto.components.taskSourceContextSummary.statusProviderAuthNeeded',
        'provider auth needed'
      )
    case 'unavailable-source-tool':
      return translate(
        'auto.components.taskSourceContextSummary.statusSourceToolUnavailable',
        'source tool unavailable'
      )
    case 'unsupported-provider':
      return translate(
        'auto.components.taskSourceContextSummary.statusProviderUnsupported',
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
      return connectingStatusLabel()
    case 'blocked':
      return translate(
        'auto.components.taskSourceContextSummary.statusServerUpdateNeeded',
        'server update needed'
      )
    case 'disconnected':
      return disconnectedStatusLabel()
    case 'error':
      return connectionIssueStatusLabel()
  }
}

function getSshStatusLabel(status: SshConnectionStatus): string {
  switch (status) {
    case 'connected':
      return translate('auto.components.taskSourceContextSummary.statusConnected', 'connected')
    case 'connecting':
    case 'deploying-relay':
    case 'reconnecting':
      return connectingStatusLabel()
    case 'auth-failed':
      return translate('auto.components.taskSourceContextSummary.statusAuthNeeded', 'auth needed')
    case 'reconnection-failed':
    case 'error':
      return connectionIssueStatusLabel()
    case 'disconnected':
      return disconnectedStatusLabel()
  }
}

function connectingStatusLabel(): string {
  return translate('auto.components.taskSourceContextSummary.statusConnecting', 'connecting')
}

function connectionIssueStatusLabel(): string {
  return translate(
    'auto.components.taskSourceContextSummary.statusConnectionIssue',
    'connection issue'
  )
}

function disconnectedStatusLabel(): string {
  return translate('auto.components.taskSourceContextSummary.statusDisconnected', 'disconnected')
}

export function formatHostStatus(host: { hostLabel: string; statusLabel: string }): string {
  return translate('auto.components.taskSourceContextSummary.hostStatus', '{{host}} {{status}}', {
    host: host.hostLabel,
    status: host.statusLabel
  })
}

export function hostTitlePart(hosts: string): string {
  return translate('auto.components.taskSourceContextSummary.hostTitle', 'Host: {{hosts}}', {
    hosts
  })
}

export function accountTitlePart(accounts: string): string {
  return translate(
    'auto.components.taskSourceContextSummary.accountTitle',
    'Account: {{accounts}}',
    { accounts }
  )
}

export function availabilityTitlePart(
  unavailableHosts: readonly { hostLabel: string; statusLabel: string }[]
): string {
  return translate(
    'auto.components.taskSourceContextSummary.availabilityTitle',
    'Availability: {{hosts}}',
    { hosts: unavailableHosts.map(formatHostStatus).join(', ') }
  )
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
  return unavailableHosts.length === 1
    ? translate(
        'auto.components.taskSourceContextSummary.unavailableCount_one',
        '{{count}} unavailable',
        { count: unavailableHosts.length }
      )
    : translate(
        'auto.components.taskSourceContextSummary.unavailableCount_other',
        '{{count}} unavailable',
        { count: unavailableHosts.length }
      )
}

export function sourceHostCountLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.taskSourceContextSummary.sourceHostCount_one',
        '{{count}} source host',
        { count }
      )
    : translate(
        'auto.components.taskSourceContextSummary.sourceHostCount_other',
        '{{count}} source hosts',
        { count }
      )
}

export function projectCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.taskSourceContextSummary.projectCount_one', '{{count}} project', {
        count
      })
    : translate(
        'auto.components.taskSourceContextSummary.projectCount_other',
        '{{count}} projects',
        { count }
      )
}

export function selectedProjectCountLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.taskSourceContextSummary.selectedProjectCount_one',
        '{{count}} selected project',
        { count }
      )
    : translate(
        'auto.components.taskSourceContextSummary.selectedProjectCount_other',
        '{{count}} selected projects',
        { count }
      )
}
