import { useCallback } from 'react'
import { toast } from 'sonner'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { useAppStore } from '../../store'
import { getWorktreeOnHostFromState } from '../../store/selectors'
import { runWorktreeBatchDelete } from '../sidebar/delete-worktree-flow'
import { showWorkspaceListChangedToast } from '../sidebar/stale-workspace-list-toast'
import { toWorktreeDeleteIdentities } from '../sidebar/worktree-delete-request'
import { prepareActiveWorktreeFocusAfterDelete } from '../sidebar/active-worktree-focus-after-delete'
import { translate } from '@/i18n/i18n'
import type { WorkspaceSpaceSortKey } from './workspace-space-presentation'
import { useWorkspaceSpaceManagerBindings } from './use-workspace-space-manager-bindings'
import { useWorkspaceSpaceDecisionProjection } from './use-workspace-space-decision-projection'
import { useWorkspaceSpaceGitRefreshAction } from './use-workspace-space-git-refresh-action'
import { useWorkspaceSpaceManagerProjection } from './use-workspace-space-manager-projection'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'

export function useWorkspaceSpaceManagerPanel() {
  const bindings = useWorkspaceSpaceManagerBindings()
  const {
    cancelWorkspaceSpaceScan,
    refreshWorkspaceSpace,
    removeWorkspaceSpaceWorktrees,
    removeWorktree,
    setInspectedWorktreeId,
    setSelectedIds,
    setSortDirection,
    setSortKey,
    setTreemapZoomWorktreeId,
    sortKey
  } = bindings
  const refresh = useCallback((): void => {
    void refreshWorkspaceSpace().catch(() => {
      /* scanError is stored by the slice */
    })
  }, [refreshWorkspaceSpace])

  const cancelScan = useCallback((): void => {
    void cancelWorkspaceSpaceScan()
  }, [cancelWorkspaceSpaceScan])

  const decision = useWorkspaceSpaceDecisionProjection(bindings)
  const refreshWorkspaceGitStatus = useWorkspaceSpaceGitRefreshAction(bindings)
  const projection = useWorkspaceSpaceManagerProjection({
    bindings,
    decision,
    refreshWorkspaceGitStatus
  })
  const { allVisibleSelected, selectedDeletableRows, visibleDeletableIdentities } = projection

  const toggleSort = (key: WorkspaceSpaceSortKey): void => {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDirection(key === 'name' || key === 'repo' ? 'asc' : 'desc')
  }

  const selectSortKey = (key: WorkspaceSpaceSortKey): void => {
    setSortKey(key)
    setSortDirection(key === 'name' || key === 'repo' ? 'asc' : 'desc')
  }

  const toggleSelection = (worktree: WorkspaceSpaceWorktree): void => {
    const identity = getWorkspaceSpaceWorktreeIdentity(worktree)
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(identity)) {
        next.delete(identity)
      } else {
        next.add(identity)
      }
      return next
    })
  }

  const toggleVisibleSelection = (): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allVisibleSelected) {
        for (const identity of visibleDeletableIdentities) {
          next.delete(identity)
        }
      } else {
        for (const identity of visibleDeletableIdentities) {
          next.add(identity)
        }
      }
      return next
    })
  }

  const handleDeletedWorktrees = useCallback(
    (deletedTargets: readonly WorktreeRemovalTarget[]): void => {
      if (deletedTargets.length === 0) {
        return
      }
      removeWorkspaceSpaceWorktrees(deletedTargets)
      const deletedIdentities = new Set(
        deletedTargets.map((target) =>
          composeWorktreeHostIdentity(target.executionHostId ?? undefined, target.id)
        )
      )
      setInspectedWorktreeId((current) =>
        current && deletedIdentities.has(current) ? null : current
      )
      setTreemapZoomWorktreeId((current) =>
        current && deletedIdentities.has(current) ? null : current
      )
      setSelectedIds((current) => {
        const next = new Set(current)
        for (const identity of deletedIdentities) {
          next.delete(identity)
        }
        return next
      })
      toast.success(
        deletedTargets.length === 1
          ? translate(
              'auto.components.status.bar.WorkspaceSpaceManagerPanel.9afc97f9a3',
              'Workspace deleted'
            )
          : translate(
              'auto.components.status.bar.WorkspaceSpaceManagerPanel.eee5240810',
              'Workspaces deleted'
            ),
        {
          description: translate(
            'auto.components.status.bar.WorkspaceSpaceManagerPanel.63efebe0e6',
            '{{value0}} {{value1}} removed from Space.',
            {
              value0: deletedTargets.length,
              value1: deletedTargets.length === 1 ? 'workspace' : 'workspaces'
            }
          )
        }
      )
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Extracted state setters keep their original stable identities.
    [removeWorkspaceSpaceWorktrees]
  )

  const deleteWorktrees = useCallback(
    (targets: readonly WorkspaceSpaceWorktree[]): void => {
      if (targets.length === 0) {
        return
      }
      // Why (STA-4343): the Space scan lists one row per host, so a bare id would
      // route the delete at whichever host the id-keyed lookup happens to hold.
      // Resolve each row on ITS host and hand over the store row's own identity.
      const state = useAppStore.getState()
      const identities = toWorktreeDeleteIdentities(
        targets.flatMap((target) => {
          const row = getWorktreeOnHostFromState(
            state,
            target.worktreeId,
            target.executionHostId ?? undefined
          )
          return row ? [row] : []
        })
      )
      if (identities.length !== targets.length) {
        showWorkspaceListChangedToast()
        return
      }
      runWorktreeBatchDelete(identities, {
        forceConfirm: true,
        forceOnConfirm: false,
        onDeleted: handleDeletedWorktrees
      })
    },
    [handleDeletedWorktrees]
  )

  const forceDeleteWorktree = useCallback(
    (worktree: WorkspaceSpaceWorktree): void => {
      // Why: Space keeps normal deletes non-force so uncommitted work is not
      // discarded silently; a failed row gets this explicit recovery path.
      const commitFocus = prepareActiveWorktreeFocusAfterDelete(worktree.worktreeId)
      // Why (#11960): explicit force recovery, so it may also waive PTY-stop proof.
      void removeWorktree(
        { id: worktree.worktreeId, executionHostId: worktree.executionHostId ?? null },
        true,
        { allowUnverifiedPtyStop: true }
      )
        .then((result) => {
          if (!result.ok) {
            toast.error(
              translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.2965415393',
                'Force delete failed'
              ),
              { description: result.error }
            )
            return
          }
          commitFocus()
          handleDeletedWorktrees([
            { id: worktree.worktreeId, executionHostId: worktree.executionHostId ?? null }
          ])
        })
        .catch((error: unknown) => {
          toast.error(
            translate(
              'auto.components.status.bar.WorkspaceSpaceManagerPanel.2965415393',
              'Force delete failed'
            ),
            { description: error instanceof Error ? error.message : String(error) }
          )
        })
    },
    [handleDeletedWorktrees, removeWorktree]
  )

  const deleteSelected = (): void => {
    if (selectedDeletableRows.length === 0) {
      return
    }
    deleteWorktrees(selectedDeletableRows)
  }

  return {
    ...bindings,
    ...decision,
    ...projection,
    deleteWorktrees,
    forceDeleteWorktree,
    deleteSelected,
    refresh,
    cancelScan,
    toggleSort,
    selectSortKey,
    toggleSelection,
    toggleVisibleSelection
  }
}
