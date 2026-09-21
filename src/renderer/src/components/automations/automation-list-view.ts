import type { TuiAgent } from '../../../../shared/tui-agent'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import type { AutomationListRow } from './automation-list-row-identity'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import {
  getAutomationRowLastRunSnapshot,
  getExternalAutomationLastRunSnapshot,
  type AutomationLastRunSnapshot
} from './automation-list-last-run'

export type AutomationListStatusFilter = 'all' | 'enabled' | 'paused'
export type AutomationListLastRunFilter = 'all' | 'failed' | 'succeeded' | 'never'
export type AutomationListSortField = 'name' | 'lastRun'
export type AutomationListSortDirection = 'asc' | 'desc'

export type AutomationListSort = {
  field: AutomationListSortField
  direction: AutomationListSortDirection
}

/**
 * A row and an external job flattened to what the shared list renders and sorts.
 *
 * `id` is the row's own key, never the bare automation ID: under All hosts two
 * authorities can return the same ID, and the sort tie-break decides render
 * order, so a bare ID would collapse them. See `automation-list-row-identity`.
 */
export type AutomationListViewItem =
  | {
      kind: 'local'
      id: string
      name: string
      enabled: boolean
      lastRunAt: number | null
      lastRun: AutomationLastRunSnapshot
      agentId: TuiAgent
      row: AutomationListRow
    }
  | {
      kind: 'external'
      id: string
      name: string
      enabled: boolean
      lastRunAt: number | null
      lastRun: AutomationLastRunSnapshot
      agentId: null
      entry: ExternalAutomationListEntry
    }

export type AutomationListFilter = {
  status: AutomationListStatusFilter
  lastRun: AutomationListLastRunFilter
  agentIds: readonly TuiAgent[]
  /** Catalog stable keys; empty (or absent, on older callers) means every host. */
  hostStableKeys?: readonly string[]
}

export const EMPTY_AUTOMATION_LIST_FILTER: AutomationListFilter = {
  status: 'all',
  lastRun: 'all',
  agentIds: [],
  hostStableKeys: []
}

function selectedHostKeys(filter: AutomationListFilter): readonly string[] {
  return filter.hostStableKeys ?? []
}

export function isAutomationListFilterActive(filter: AutomationListFilter): boolean {
  return (
    filter.status !== 'all' ||
    filter.lastRun !== 'all' ||
    filter.agentIds.length > 0 ||
    selectedHostKeys(filter).length > 0
  )
}

export function countAutomationListFilters(filter: AutomationListFilter): number {
  return (
    (filter.status !== 'all' ? 1 : 0) +
    (filter.lastRun !== 'all' ? 1 : 0) +
    (filter.agentIds.length > 0 ? 1 : 0) +
    (selectedHostKeys(filter).length > 0 ? 1 : 0)
  )
}

export function defaultAutomationListSortDirection(
  field: AutomationListSortField
): AutomationListSortDirection {
  return field === 'lastRun' ? 'desc' : 'asc'
}

export function nextAutomationListSort(
  current: AutomationListSort | null,
  field: AutomationListSortField
): AutomationListSort {
  if (current?.field !== field) {
    return { field, direction: defaultAutomationListSortDirection(field) }
  }
  return {
    field,
    direction: current.direction === 'asc' ? 'desc' : 'asc'
  }
}

function matchesStatusFilter(enabled: boolean, filter: AutomationListStatusFilter): boolean {
  if (filter === 'all') {
    return true
  }
  return filter === 'enabled' ? enabled : !enabled
}

function matchesLastRunFilter(
  snapshot: AutomationLastRunSnapshot,
  filter: AutomationListLastRunFilter
): boolean {
  if (filter === 'all') {
    return true
  }
  return snapshot.tone === filter
}

/** Flattens the two rendered collections into one sortable list, preserving row identity. */
export function buildAutomationListViewItems({
  rows,
  externalEntries
}: {
  rows: readonly AutomationListRow[]
  externalEntries: readonly ExternalAutomationListEntry[]
}): AutomationListViewItem[] {
  const locals: AutomationListViewItem[] = rows.map((row) => {
    // Why: the same snapshot the row cell renders, so the sort matches the column.
    const lastRun = getAutomationRowLastRunSnapshot(row)
    return {
      kind: 'local',
      id: row.key,
      name: row.automation.name,
      enabled: row.automation.enabled,
      lastRunAt: lastRun.at,
      lastRun,
      agentId: row.automation.agentId,
      row
    }
  })
  const externals: AutomationListViewItem[] = externalEntries.map((entry) => {
    const lastRun = getExternalAutomationLastRunSnapshot(entry.job)
    return {
      kind: 'external',
      id: entry.key,
      name: entry.job.name,
      enabled: entry.job.enabled,
      lastRunAt: lastRun.at,
      lastRun,
      agentId: null,
      entry
    }
  })
  return [...locals, ...externals]
}

/** A pre-catalog row names no host, so a host filter (which implies a hydrated catalog) excludes it. */
function matchesHostFilter(hostKey: string | null, keys: readonly string[]): boolean {
  return keys.length === 0 || (hostKey !== null && keys.includes(hostKey))
}

/** External jobs live on their listing scope's host, mirrored into the same stable-key space. */
function externalEntryHostStableKey(entry: ExternalAutomationListEntry): string {
  const owner = entry.scope.owner
  return hostStableKey({
    authority:
      owner.authority.kind === 'runtime'
        ? { kind: 'runtime', environmentId: owner.authority.environmentId }
        : { kind: 'desktop' },
    selector:
      owner.selector.kind === 'ssh'
        ? { kind: 'ssh', targetId: owner.selector.targetId }
        : { kind: 'self' }
  })
}

/** The attribute filter over catalog rows; identity-stable when the filter is inactive. */
export function filterAutomationListRows(
  rows: readonly AutomationListRow[],
  filter: AutomationListFilter
): readonly AutomationListRow[] {
  if (!isAutomationListFilterActive(filter)) {
    return rows
  }
  const hostKeys = selectedHostKeys(filter)
  return rows.filter(
    (row) =>
      matchesHostFilter(row.catalogRef ? hostStableKey(row.catalogRef) : null, hostKeys) &&
      matchesStatusFilter(row.automation.enabled, filter.status) &&
      matchesLastRunFilter(getAutomationRowLastRunSnapshot(row), filter.lastRun) &&
      (filter.agentIds.length === 0 || filter.agentIds.includes(row.automation.agentId))
  )
}

/** External jobs have no Orca agent, so any agent filter excludes them — matching the old view. */
export function filterExternalAutomationListEntries(
  entries: readonly ExternalAutomationListEntry[],
  filter: AutomationListFilter
): readonly ExternalAutomationListEntry[] {
  if (!isAutomationListFilterActive(filter)) {
    return entries
  }
  if (filter.agentIds.length > 0) {
    return []
  }
  const hostKeys = selectedHostKeys(filter)
  return entries.filter(
    (entry) =>
      matchesHostFilter(externalEntryHostStableKey(entry), hostKeys) &&
      matchesStatusFilter(entry.job.enabled, filter.status) &&
      matchesLastRunFilter(getExternalAutomationLastRunSnapshot(entry.job), filter.lastRun)
  )
}

/**
 * `locale` is a parameter, not a `getIntlLocale()` read, so callers memoizing this
 * can declare it — a hidden read is invisible to a dependency array.
 */
export function sortAutomationListViewItems(
  items: readonly AutomationListViewItem[],
  sort: AutomationListSort | null,
  locale: string
): AutomationListViewItem[] {
  if (!sort || items.length < 2) {
    return [...items]
  }
  const next = [...items]
  const compareNames =
    sort.field === 'name' ? new Intl.Collator(locale, { sensitivity: 'base' }).compare : null
  next.sort((left, right) => {
    const compared = compareNames
      ? compareNames(left.name, right.name)
      : (left.lastRunAt ?? 0) - (right.lastRunAt ?? 0)
    if (compared !== 0) {
      return sort.direction === 'asc' ? compared : -compared
    }
    return left.id.localeCompare(right.id)
  })
  return next
}

/** The rendered list: filter each collection with its own rules, then sort as one. */
export function applyAutomationListView({
  rows,
  externalEntries,
  filter,
  sort,
  locale
}: {
  rows: readonly AutomationListRow[]
  externalEntries: readonly ExternalAutomationListEntry[]
  filter: AutomationListFilter
  sort: AutomationListSort | null
  locale: string
}): AutomationListViewItem[] {
  return sortAutomationListViewItems(
    buildAutomationListViewItems({
      rows: filterAutomationListRows(rows, filter),
      externalEntries: filterExternalAutomationListEntries(externalEntries, filter)
    }),
    sort,
    locale
  )
}
