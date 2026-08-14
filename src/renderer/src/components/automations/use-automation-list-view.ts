import { useEffect, useMemo } from 'react'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import {
  applyAutomationListView,
  isAutomationListFilterActive,
  type AutomationListFilter,
  type AutomationListSort,
  type AutomationListViewItem
} from './automation-list-view'

export function useAutomationListView({
  automations,
  externalEntries,
  runs,
  filter,
  sort,
  selectedId,
  selectedExternalKey,
  selectAutomationId,
  selectExternalKey
}: {
  automations: readonly Automation[]
  externalEntries: readonly ExternalAutomationListEntry[]
  runs: readonly AutomationRun[]
  filter: AutomationListFilter
  sort: AutomationListSort | null
  selectedId: string | null
  selectedExternalKey: string | null
  selectAutomationId: (automationId: string | null) => void
  selectExternalKey: (externalKey: string | null) => void
}): {
  visibleItems: readonly AutomationListViewItem[]
  isListFilterActive: boolean
  hasVisibleListItems: boolean
} {
  const isListFilterActive = isAutomationListFilterActive(filter)
  const visibleItems = useMemo(
    () =>
      applyAutomationListView({
        automations,
        externalEntries,
        runs,
        filter,
        sort
      }),
    [automations, externalEntries, filter, runs, sort]
  )
  const hasVisibleListItems = visibleItems.length > 0

  // Why: search already hides rows; filter/sort must keep highlight + detail on a
  // still-visible row so the list never points at something the user cannot see.
  useEffect(() => {
    if (!isListFilterActive && !sort) {
      return
    }
    const localVisible =
      selectedExternalKey === null &&
      selectedId != null &&
      visibleItems.some((item) => item.kind === 'local' && item.id === selectedId)
    const externalVisible =
      selectedExternalKey != null &&
      visibleItems.some((item) => item.kind === 'external' && item.id === selectedExternalKey)
    if (localVisible || externalVisible) {
      return
    }
    const first = visibleItems[0]
    if (!first) {
      return
    }
    if (first.kind === 'local') {
      if (selectedExternalKey !== null) {
        selectExternalKey(null)
      }
      if (selectedId !== first.id) {
        selectAutomationId(first.id)
      }
      return
    }
    if (selectedExternalKey !== first.id) {
      selectExternalKey(first.id)
    }
  }, [
    isListFilterActive,
    selectAutomationId,
    selectExternalKey,
    selectedExternalKey,
    selectedId,
    sort,
    visibleItems
  ])

  return {
    visibleItems,
    isListFilterActive,
    hasVisibleListItems
  }
}
