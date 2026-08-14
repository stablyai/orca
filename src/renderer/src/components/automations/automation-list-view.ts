import { getIntlLocale } from '@/i18n/i18n'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import {
  getExternalAutomationLastRunSnapshot,
  getLocalAutomationLastRunSnapshot,
  indexLatestAutomationRuns,
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

export type AutomationListViewItem =
  | {
      kind: 'local'
      id: string
      name: string
      enabled: boolean
      lastRunAt: number | null
      lastRun: AutomationLastRunSnapshot
      automation: Automation
    }
  | {
      kind: 'external'
      id: string
      name: string
      enabled: boolean
      lastRunAt: number | null
      lastRun: AutomationLastRunSnapshot
      entry: ExternalAutomationListEntry
    }

export type AutomationListFilter = {
  status: AutomationListStatusFilter
  lastRun: AutomationListLastRunFilter
}

export const EMPTY_AUTOMATION_LIST_FILTER: AutomationListFilter = {
  status: 'all',
  lastRun: 'all'
}

export function isAutomationListFilterActive(filter: AutomationListFilter): boolean {
  return filter.status !== 'all' || filter.lastRun !== 'all'
}

export function countAutomationListFilters(filter: AutomationListFilter): number {
  return (filter.status !== 'all' ? 1 : 0) + (filter.lastRun !== 'all' ? 1 : 0)
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

export function buildAutomationListViewItems({
  automations,
  externalEntries,
  runs
}: {
  automations: readonly Automation[]
  externalEntries: readonly ExternalAutomationListEntry[]
  runs: readonly AutomationRun[]
}): AutomationListViewItem[] {
  const lastRunByAutomationId = indexLatestAutomationRuns(runs)
  const locals: AutomationListViewItem[] = automations.map((automation) => {
    const lastRun = getLocalAutomationLastRunSnapshot(
      automation,
      lastRunByAutomationId.get(automation.id)
    )
    return {
      kind: 'local',
      id: automation.id,
      name: automation.name,
      enabled: automation.enabled,
      lastRunAt: lastRun.at,
      lastRun,
      automation
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
      entry
    }
  })
  return [...locals, ...externals]
}

export function filterAutomationListViewItems(
  items: readonly AutomationListViewItem[],
  filter: AutomationListFilter
): AutomationListViewItem[] {
  if (!isAutomationListFilterActive(filter)) {
    return [...items]
  }
  return items.filter(
    (item) =>
      matchesStatusFilter(item.enabled, filter.status) &&
      matchesLastRunFilter(item.lastRun, filter.lastRun)
  )
}

export function sortAutomationListViewItems(
  items: readonly AutomationListViewItem[],
  sort: AutomationListSort | null
): AutomationListViewItem[] {
  if (!sort) {
    return [...items]
  }
  const next = [...items]
  const locale = getIntlLocale()
  next.sort((left, right) => {
    const compared =
      sort.field === 'name'
        ? left.name.localeCompare(right.name, locale, { sensitivity: 'base' })
        : (left.lastRunAt ?? 0) - (right.lastRunAt ?? 0)
    if (compared !== 0) {
      return sort.direction === 'asc' ? compared : -compared
    }
    return left.id.localeCompare(right.id)
  })
  return next
}

export function applyAutomationListView({
  automations,
  externalEntries,
  runs,
  filter,
  sort
}: {
  automations: readonly Automation[]
  externalEntries: readonly ExternalAutomationListEntry[]
  runs: readonly AutomationRun[]
  filter: AutomationListFilter
  sort: AutomationListSort | null
}): AutomationListViewItem[] {
  return sortAutomationListViewItems(
    filterAutomationListViewItems(
      buildAutomationListViewItems({ automations, externalEntries, runs }),
      filter
    ),
    sort
  )
}
