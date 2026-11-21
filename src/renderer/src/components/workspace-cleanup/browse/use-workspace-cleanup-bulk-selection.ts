import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  type Dispatch,
  type SetStateAction
} from 'react'
import { toast } from 'sonner'
import {
  canQueueWorkspaceCleanupCandidate,
  type WorkspaceCleanupCandidate
} from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import type { WorkspaceCleanupFacets } from '../query/workspace-cleanup-facets'
import { formatVanishedSelectionNotice } from './workspace-cleanup-selection-model'

type BulkSelectionRow = Pick<WorkspaceCleanupFacets, 'candidate' | 'identity' | 'isSelectable'>

function countSelected(identities: readonly string[], selectedIds: ReadonlySet<string>): number {
  let count = 0
  for (const identity of identities) {
    if (selectedIds.has(identity)) {
      count += 1
    }
  }
  return count
}

/**
 * Selection bookkeeping for the displayed (held) rows.
 * - Bulk controls act on what is displayed: select-all adds bulk-selectable rows only (never
 *   manually excluded ones), while clearing removes every displayed check.
 * - A row a queue blocker makes undeletable is un-checked and stays un-checked; the user must
 *   tick it again if the blocker later clears. Confirmation still re-checks safety on its own.
 */
export function useWorkspaceCleanupBulkSelection({
  rows,
  selectedIds,
  setSelectedIds,
  deletingIdentities,
  removalInFlight,
  evidencedCandidates,
  candidateIdentities,
  loading
}: {
  rows: readonly BulkSelectionRow[]
  selectedIds: ReadonlySet<string>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  deletingIdentities: ReadonlySet<string>
  removalInFlight: boolean
  evidencedCandidates: readonly WorkspaceCleanupCandidate[]
  candidateIdentities: ReadonlySet<string>
  loading: boolean
}): {
  bulkSelectableCount: number
  selectedBulkCount: number
  selectedDisplayedCount: number
  toggleSelectAll: (selectAll: boolean) => void
} {
  const unselectableIdentities = useMemo(() => {
    const identities = new Set<string>()
    for (const candidate of evidencedCandidates) {
      if (!canQueueWorkspaceCleanupCandidate(candidate)) {
        identities.add(getWorkspaceCleanupCandidateIdentity(candidate))
      }
    }
    return identities
  }, [evidencedCandidates])

  const pruneStaleSelections = useEffectEvent(() => {
    const isDeleting = (identity: string): boolean => deletingIdentities.has(identity)
    // While a scan streams, an absent identity may simply not have arrived yet.
    const keep = (identity: string): boolean =>
      (loading || candidateIdentities.has(identity)) &&
      !isDeleting(identity) &&
      !unselectableIdentities.has(identity)
    const vanishedCount = loading
      ? 0
      : [...selectedIds].filter(
          (identity) => !candidateIdentities.has(identity) && !isDeleting(identity)
        ).length
    // Apply to the latest selection so a concurrent prune's removals are never restored.
    setSelectedIds((current) => {
      const next = new Set([...current].filter(keep))
      return next.size === current.size ? current : next
    })
    if (vanishedCount > 0) {
      toast.info(formatVanishedSelectionNotice(vanishedCount))
    }
  })
  useEffect(() => {
    pruneStaleSelections()
  }, [candidateIdentities, deletingIdentities, loading, unselectableIdentities])

  const { bulkIdentities, displayedIdentities } = useMemo(() => {
    const bulk: string[] = []
    const displayed: string[] = []
    if (!removalInFlight) {
      for (const row of rows) {
        if (
          deletingIdentities.has(row.identity) ||
          !canQueueWorkspaceCleanupCandidate(row.candidate)
        ) {
          continue
        }
        displayed.push(row.identity)
        if (row.isSelectable) {
          bulk.push(row.identity)
        }
      }
    }
    return { bulkIdentities: bulk, displayedIdentities: displayed }
  }, [deletingIdentities, removalInFlight, rows])

  const toggleSelectAll = useCallback(
    (selectAll: boolean) => {
      setSelectedIds((current) => {
        const next = new Set(current)
        for (const identity of selectAll ? bulkIdentities : displayedIdentities) {
          if (selectAll) {
            next.add(identity)
          } else {
            next.delete(identity)
          }
        }
        return next
      })
    },
    [bulkIdentities, displayedIdentities, setSelectedIds]
  )

  return {
    bulkSelectableCount: bulkIdentities.length,
    selectedBulkCount: countSelected(bulkIdentities, selectedIds),
    selectedDisplayedCount: countSelected(displayedIdentities, selectedIds),
    toggleSelectAll
  }
}
