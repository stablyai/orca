import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import { worktreeParentPlacementFor } from '../../workspace-actions/parenting/worktree-parent-candidates'
import { showCrossStoreParentError } from '../../workspace-actions/parenting/worktree-parent-selection'
import { useAllWorktrees } from '@/store/selectors'
import { selectSidebarLineageParentIdentities } from '@/store/cross-store-lineage-parents'
import { isCrossStoreParent } from '@/store/slices/worktrees/metadata/cross-store-parent-ref'
import type { DraggedWorktreeCopies } from './dragged-worktree-copies'
import { getCyclicProjectedWorktreeLineageIds } from '../../../../../../shared/sidebar-list/worktree-lineage-projection'
import { getReorderedWorktreeIdsToUnnest } from './worktree-lineage-drag-drop'
import { unnestWorktrees } from '../../workspace-actions/parenting/worktree-unnest'
import {
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { WorktreeDragGroup } from './worktree-manual-order'
import type { WorktreeSidebarLineageDropTarget } from './row-state'

export type WorktreeLineageDropCommit = ReturnType<typeof useWorktreeLineageDropCommit>

export function useWorktreeLineageDropCommit(args: {
  repoMap: Map<string, Repo>
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  worktreeDragGroups: readonly WorktreeDragGroup[]
}) {
  const { repoMap, worktreeMap, worktreeLineageById, worktreeDragGroups } = args
  const worktrees = useAllWorktrees()
  const parentIdentities = useAppStore(selectSidebarLineageParentIdentities)
  const assignWorktreeParent = useAppStore((s) => s.assignWorktreeParent)
  const assignCrossStoreWorktreeParent = useAppStore((s) => s.assignCrossStoreWorktreeParent)
  const updateWorktreeLineage = useAppStore((s) => s.updateWorktreeLineage)
  const cyclicLineageIds = useMemo(
    () => getCyclicProjectedWorktreeLineageIds(worktreeLineageById, worktreeMap),
    [worktreeLineageById, worktreeMap]
  )
  // Drops name rows by host identity: a parent or child may be on another machine than its twin.
  const rowsByIdentity = useMemo(
    () => new Map<string, Worktree>(worktrees.map((row) => [getWorktreeHostIdentity(row), row])),
    [worktrees]
  )

  /** The picked rows and the parent row, when the picker would offer that parent to every one. */
  const resolveLineageDrop = useCallback(
    (
      pickedCopies: DraggedWorktreeCopies,
      parentIdentity: string
    ): { children: Worktree[]; parent: Worktree } | null => {
      const parent = rowsByIdentity.get(parentIdentity)
      if (!parent || pickedCopies.length === 0) {
        return null
      }
      const children: Worktree[] = []
      for (const copy of pickedCopies) {
        const child = rowsByIdentity.get(getWorktreeHostIdentity(copy))
        const placement = child
          ? worktreeParentPlacementFor({
              child,
              worktrees,
              lineageById: worktreeLineageById,
              worktreeMap,
              repoMap,
              cyclicLineageIds,
              parentIdentities
            })(parent)
          : null
        if (!child || !placement) {
          return null
        }
        children.push(child)
      }
      return { children, parent }
    },
    [
      cyclicLineageIds,
      parentIdentities,
      repoMap,
      rowsByIdentity,
      worktreeLineageById,
      worktreeMap,
      worktrees
    ]
  )

  const getEligibleLineageDropTarget = useCallback(
    (
      target: WorktreeSidebarLineageDropTarget,
      pickedCopies: DraggedWorktreeCopies
    ): WorktreeSidebarLineageDropTarget =>
      !target.lineageParentIdentity ||
      resolveLineageDrop(pickedCopies, target.lineageParentIdentity)
        ? target
        : { ...target, lineageParentIdentity: null },
    [resolveLineageDrop]
  )

  const commitWorktreeLineageParentDrop = useCallback(
    (pickedCopies: DraggedWorktreeCopies, parentIdentity: string): boolean => {
      const drop = resolveLineageDrop(pickedCopies, parentIdentity)
      if (!drop) {
        return false
      }
      const { children, parent } = drop
      const crossStore = children.filter((child) => isCrossStoreParent(child, parent))
      const sameStore = children.filter((child) => !isCrossStoreParent(child, parent))
      void (async () => {
        try {
          // Cross-machine refs are all validated before any write, so a refusal changes nothing.
          if (crossStore.length > 0) {
            await assignCrossStoreWorktreeParent(crossStore, parent)
          }
        } catch (error) {
          showCrossStoreParentError(error)
          return
        }
        await Promise.all(
          sameStore.map((child) =>
            assignWorktreeParent(child.id, {
              parentWorktreeId: parent.id,
              ...(child.hostId ? { executionHostId: child.hostId } : {})
            })
          )
        ).catch((err) => {
          console.error('Failed to nest workspace:', err)
          toast.error(
            translate(
              'auto.components.sidebar.WorktreeList.failedNestWorkspace',
              'Failed to nest workspace'
            )
          )
        })
      })()
      return true
    },
    [assignCrossStoreWorktreeParent, assignWorktreeParent, resolveLineageDrop]
  )

  const clearReorderedWorktreeParents = useCallback(
    (unnestArgs: { draggedIds: readonly string[]; sourceGroupKey: string }) => {
      const sourceGroup = worktreeDragGroups.find(
        (group) => group.key === unnestArgs.sourceGroupKey
      )
      if (!sourceGroup) {
        return
      }
      const ids = getReorderedWorktreeIdsToUnnest({
        draggedIds: unnestArgs.draggedIds,
        // Lineage is keyed by worktree id; drag groups key members by host identity.
        sourceGroupIds: sourceGroup.worktreeIds.map(getWorktreeIdFromHostIdentity),
        lineageById: worktreeLineageById,
        worktreeMap,
        cyclicLineageIds
      })
      if (ids.length === 0) {
        return
      }
      // Why: dropping a nested card on a reorder line is the un-nest escape hatch; clear only the dragged children.
      void unnestWorktrees(ids, updateWorktreeLineage)
    },
    [cyclicLineageIds, updateWorktreeLineage, worktreeDragGroups, worktreeLineageById, worktreeMap]
  )

  return {
    getEligibleLineageDropTarget,
    commitWorktreeLineageParentDrop,
    clearReorderedWorktreeParents
  }
}
