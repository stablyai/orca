import { useCallback } from 'react'
import { toast } from 'sonner'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import {
  toWorktreeRemovalTarget,
  type WorktreeRemovalTarget
} from '../../../../shared/worktree/removal'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { useAppStore } from '../../store'
import { getWorktreeOnHostFromState } from '../../store/selectors'
import { runWorktreeBatchDelete } from '../sidebar/delete-worktree-flow'
import { dismissDeleteWorktreeFailureToast } from '../sidebar/delete-worktree-failure-toast'
import { showWorkspaceListChangedToast } from '../sidebar/stale-workspace-list-toast'
import { toWorktreeDeleteIdentities } from '../sidebar/worktree-delete-request'
import { translate } from '@/i18n/i18n'
import type { WorkspaceSpaceSortKey } from './workspace-space-presentation'
import { useWorkspaceSpaceManagerBindings } from './use-workspace-space-manager-bindings'
import { useWorkspaceSpaceDecisionProjection } from './use-workspace-space-decision-projection'
import { useWorkspaceSpaceGitRefreshAction } from './use-workspace-space-git-refresh-action'
import { useWorkspaceSpaceManagerProjection } from './use-workspace-space-manager-projection'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'
import { blockRemovalForUnsavedFiles } from '../sidebar/removal-unsaved-files'

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
    void refreshWorkspaceSpace()
      .then((analysis) => {
        void window.api.workspaceSpace.publishWindowAnalysis?.(analysis)
      })
      .catch(() => {
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
      for (const target of deletedTargets) {
        dismissDeleteWorktreeFailureToast(target)
      }
      void window.api.workspaceSpace.requestWorktreeRefresh?.()
      const deletedIdentities = new Set<string>(
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
          description:
            deletedTargets.length === 1
              ? translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.removedFromSpace_one',
                  '{{count}} workspace removed from Space.',
                  { count: deletedTargets.length }
                )
              : translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.removedFromSpace_other',
                  '{{count}} workspaces removed from Space.',
                  { count: deletedTargets.length }
                )
        }
      )
    },
    [
      removeWorkspaceSpaceWorktrees,
      setInspectedWorktreeId,
      setSelectedIds,
      setTreemapZoomWorktreeId
    ]
  )

  const deleteWorktrees = useCallback(
    (
      targets: readonly WorkspaceSpaceWorktree[],
      { forceOnConfirm = false }: { forceOnConfirm?: boolean } = {}
    ): void => {
      if (targets.length === 0) {
        return
      }
      // Resolve each scan row on its host and use the store’s instance identity so deletion cannot target a same-ID checkout elsewhere.
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
        forceOnConfirm,
        onDeleted: handleDeletedWorktrees
      })
    },
    [handleDeletedWorktrees]
  )

  const forceDeleteWorktree = useCallback(
    (worktree: WorkspaceSpaceWorktree): void => {
      // Keep bulk deletion non-force; resolve retry toast identity through the store row’s host.
      const storeRow = getWorktreeOnHostFromState(
        useAppStore.getState(),
        worktree.worktreeId,
        worktree.executionHostId ?? undefined
      )
      // Why: this retry has no list of its own, so edits made since the first attempt refuse it.
      if (
        blockRemovalForUnsavedFiles(
          useAppStore.getState,
          [{ id: worktree.worktreeId, hostId: worktree.executionHostId ?? undefined }],
          worktree.displayName
        )
      ) {
        return
      }
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
          if (storeRow) {
            dismissDeleteWorktreeFailureToast(toWorktreeRemovalTarget(storeRow))
          }
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
