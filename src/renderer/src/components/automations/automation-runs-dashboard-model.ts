import type { AutomationRun, AutomationRunStatus } from '../../../../shared/automations-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { AutomationActionNotice } from './automation-row-action-dispatch'
import type { AutomationListRow } from './automation-list-row-identity'

export type AutomationRunsScope = 'local' | 'remote'
export type AutomationRunsStatusFilter = 'all' | 'successful' | 'failed' | 'active' | 'skipped'

export type AutomationRunsDashboardEntry = {
  key: string
  hostKey: string
  searchText: string
  row: AutomationListRow
  run: AutomationRun
  scope: AutomationRunsScope
}

export type AutomationRunsDashboardFailure = {
  row: AutomationListRow
  scope: AutomationRunsScope
  notice: AutomationActionNotice
}

export function getAutomationRunsHostKey(row: AutomationListRow): string {
  const authority = row.catalogRef?.authority
  const selector = row.catalogRef?.selector
  const authorityKey =
    authority?.kind === 'runtime' ? `runtime:${authority.environmentId}` : 'desktop'
  const selectorKey =
    selector?.kind === 'ssh'
      ? `ssh:${selector.targetId}`
      : selector?.kind === 'orphan'
        ? 'orphan'
        : 'self'
  return `${authorityKey}:${selectorKey}`
}

export function getAutomationRunsScope(row: AutomationListRow): AutomationRunsScope {
  const authority = row.catalogRef?.authority
  const selector = row.catalogRef?.selector
  if (authority?.kind === 'runtime' || selector?.kind === 'ssh') {
    return 'remote'
  }
  if (selector?.kind === 'self') {
    return 'local'
  }
  const runHost = parseExecutionHostId(row.automation.runContext?.hostId)
  return row.automation.executionTargetType === 'ssh' || runHost?.kind === 'runtime'
    ? 'remote'
    : 'local'
}

export function buildAutomationRunsDashboardEntries(
  rows: readonly AutomationListRow[],
  runsByRowKey: ReadonlyMap<string, readonly AutomationRun[]>
): AutomationRunsDashboardEntry[] {
  return rows
    .flatMap((row) =>
      (runsByRowKey.get(row.key) ?? []).map((run) => ({
        key: `${row.key}:${run.id}`,
        hostKey: getAutomationRunsHostKey(row),
        searchText: [row.automation.name, run.title, row.hostLabel].join('\n').toLocaleLowerCase(),
        row,
        run,
        scope: getAutomationRunsScope(row)
      }))
    )
    .sort((left, right) => right.run.scheduledFor - left.run.scheduledFor)
}

function matchesStatus(status: AutomationRunStatus, filter: AutomationRunsStatusFilter): boolean {
  if (filter === 'all') {
    return true
  }
  if (filter === 'successful') {
    return status === 'completed'
  }
  if (filter === 'failed') {
    return status === 'dispatch_failed'
  }
  if (filter === 'skipped') {
    return status.startsWith('skipped')
  }
  return status === 'pending' || status === 'dispatching' || status === 'dispatched'
}

export function filterAutomationRunsDashboardEntries({
  entries,
  status,
  query,
  hostKeys
}: {
  entries: readonly AutomationRunsDashboardEntry[]
  status: AutomationRunsStatusFilter
  query: string
  hostKeys: readonly string[]
}): AutomationRunsDashboardEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const selectedHosts = new Set(hostKeys)
  return entries.filter((entry) => {
    if (
      !matchesStatus(entry.run.status, status) ||
      (selectedHosts.size > 0 && !selectedHosts.has(entry.hostKey))
    ) {
      return false
    }
    if (!normalizedQuery) {
      return true
    }
    return entry.searchText.includes(normalizedQuery)
  })
}

export function countAutomationRunOutcomes(
  entries: readonly AutomationRunsDashboardEntry[],
  now: number
): { successful24h: number; failed24h: number; successful7d: number; failed7d: number } {
  const dayAgo = now - 24 * 60 * 60 * 1000
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000
  const counts = { successful24h: 0, failed24h: 0, successful7d: 0, failed7d: 0 }
  for (const entry of entries) {
    // A clock-skewed or future-dated run has not happened inside either window yet.
    if (entry.run.scheduledFor > now) {
      continue
    }
    const successful = entry.run.status === 'completed'
    const failed = entry.run.status === 'dispatch_failed'
    if (entry.run.scheduledFor >= weekAgo) {
      counts.successful7d += successful ? 1 : 0
      counts.failed7d += failed ? 1 : 0
    }
    if (entry.run.scheduledFor >= dayAgo) {
      counts.successful24h += successful ? 1 : 0
      counts.failed24h += failed ? 1 : 0
    }
  }
  return counts
}
