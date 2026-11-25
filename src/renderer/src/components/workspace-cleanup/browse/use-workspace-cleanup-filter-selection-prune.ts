import { useEffect, useEffectEvent, useMemo, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import type { WorkspaceCleanupFilterState } from '../../../../../shared/workspace-cleanup/workspace-cleanup-filter-model'
import { formatWithheldSelectionNotice } from './workspace-cleanup-selection-model'

/**
 * Drops selected rows the user's own filter or search change hid, with a toast. Returns the
 * identities matching the filters and search (held rows that stopped matching are not in it).
 */
export function useWorkspaceCleanupFilterSelectionPrune({
  open,
  confirming,
  filters,
  matchedRows,
  deletingIdentities,
  selectedIds,
  setSelectedIds
}: {
  open: boolean
  confirming: boolean
  filters: WorkspaceCleanupFilterState
  matchedRows: readonly { identity: string }[]
  deletingIdentities: ReadonlySet<string>
  selectedIds: ReadonlySet<string>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
}): ReadonlySet<string> {
  const matchedIdentities = useMemo(
    () => new Set(matchedRows.map((row) => row.identity)),
    [matchedRows]
  )

  const pruneSelectionToVisibleRows = useEffectEvent(() => {
    if (!open || confirming || selectedIds.size === 0) {
      return
    }
    const keep = (identity: string): boolean =>
      matchedIdentities.has(identity) && !deletingIdentities.has(identity)
    const withheldCount = [...selectedIds].filter((identity) => !keep(identity)).length
    if (withheldCount === 0) {
      return
    }
    // Apply to the latest selection so a concurrent prune's removals are never restored.
    setSelectedIds((current) => {
      const next = new Set([...current].filter(keep))
      return next.size === current.size ? current : next
    })
    toast.info(formatWithheldSelectionNotice(withheldCount))
  })

  useEffect(() => {
    // Prune destructive selections only when user filters change. Streaming reclassification and
    // returning from confirmation must not silently deselect rows the list still displays.
    pruneSelectionToVisibleRows()
  }, [filters, open])

  return matchedIdentities
}
