import { useMemo } from 'react'
import type { Repo } from '../../../../../shared/repo-types'
import { getAutomationRunRepoId } from '../../../../../shared/automations/history/automation-run-identity'
import { useTranslate } from '@/i18n/use-translate'
import type { AutomationListRow } from './automation-list-row-identity'
import type { AutomationListViewItem } from './automation-list-view'
import {
  automationListItemNeedsAttention,
  groupAutomationListItems
} from './automation-list-groups'
import {
  automationRowHostLabel,
  externalAutomationHostLabel,
  hasMultipleAutomationHosts
} from './automation-list-host'

const EMPTY_HOST_LABELS: ReadonlyMap<string, string> = new Map()

/** The list's groups, their flattened render order, and whether it needs a Host column. */
export function useAutomationListGroups({
  sortedListItems,
  needsMigration,
  repoForRow,
  repoMap,
  hostLabelById = EMPTY_HOST_LABELS
}: {
  sortedListItems: readonly AutomationListViewItem[]
  needsMigration?: (row: AutomationListRow) => boolean
  repoForRow?: (row: AutomationListRow) => Repo | undefined
  repoMap: ReadonlyMap<string, Repo>
  hostLabelById?: ReadonlyMap<string, string>
}) {
  const t = useTranslate()
  const groups = useMemo(
    () =>
      groupAutomationListItems(sortedListItems, (item) =>
        automationListItemNeedsAttention(item, (local) => Boolean(needsMigration?.(local.row)))
      ),
    [needsMigration, sortedListItems]
  )
  const showHost = useMemo(
    () =>
      hasMultipleAutomationHosts(
        sortedListItems.map((item) =>
          item.kind === 'local'
            ? automationRowHostLabel(
                item.row,
                repoForRow
                  ? repoForRow(item.row)
                  : repoMap.get(getAutomationRunRepoId(item.row.automation)),
                hostLabelById
              )
            : externalAutomationHostLabel(item.entry, t)
        )
      ),
    [hostLabelById, repoForRow, repoMap, sortedListItems, t]
  )
  // Why: keyboard traversal and focus recovery read render order, which the groups own.
  const orderedItems = useMemo(() => groups.flatMap((group) => group.items), [groups])
  return { groups, showHost, orderedItems }
}
