import React, { useCallback, useMemo, useState } from 'react'
import type { Worktree } from '../../../../shared/types'
import {
  areWorktreeSelectionsEqual,
  getWorktreeSelectionIntent,
  pruneWorktreeSelection,
  updateWorktreeAreaSelection,
  updateWorktreeSelection
} from './worktree-multi-selection'

export function useWorkspaceKanbanSelection(open: boolean, boardWorktrees: readonly Worktree[]) {
  const boardWorktreeIds = useMemo(
    () => boardWorktrees.map((worktree) => worktree.id),
    [boardWorktrees]
  )
  const [selectedWorktreeIds, setSelectedWorktreeIds] = useState<Set<string>>(new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)
  const selectedWorktrees = useMemo(
    () => boardWorktrees.filter((worktree) => selectedWorktreeIds.has(worktree.id)),
    [boardWorktrees, selectedWorktreeIds]
  )

  if (!open) {
    if (selectedWorktreeIds.size > 0) {
      setSelectedWorktreeIds(new Set())
    }
    if (selectionAnchorId !== null) {
      setSelectionAnchorId(null)
    }
  } else {
    const pruned = pruneWorktreeSelection(selectedWorktreeIds, selectionAnchorId, boardWorktreeIds)
    // Why: the drawer can keep rendering while rows are filtered/reordered.
    // Prune stale local selection before children see ids that no longer exist.
    if (!areWorktreeSelectionsEqual(selectedWorktreeIds, pruned.selectedIds)) {
      setSelectedWorktreeIds(pruned.selectedIds)
    }
    if (selectionAnchorId !== pruned.anchorId) {
      setSelectionAnchorId(pruned.anchorId)
    }
  }

  const updateSelectionForGesture = useCallback(
    (event: React.MouseEvent<HTMLElement>, worktreeId: string): boolean => {
      const intent = getWorktreeSelectionIntent(event, navigator.userAgent.includes('Mac'))
      const result = updateWorktreeSelection({
        visibleIds: boardWorktreeIds,
        previousSelectedIds: selectedWorktreeIds,
        previousAnchorId: selectionAnchorId,
        targetId: worktreeId,
        intent
      })
      setSelectedWorktreeIds(result.selectedIds)
      setSelectionAnchorId(result.anchorId)
      return intent !== 'replace'
    },
    [boardWorktreeIds, selectedWorktreeIds, selectionAnchorId]
  )

  const selectForContextMenu = useCallback(
    (_event: React.MouseEvent<HTMLElement>, worktree: Worktree): readonly Worktree[] => {
      if (selectedWorktreeIds.has(worktree.id) && selectedWorktreeIds.size > 1) {
        return selectedWorktrees
      }
      setSelectedWorktreeIds(new Set([worktree.id]))
      setSelectionAnchorId(worktree.id)
      return [worktree]
    },
    [selectedWorktreeIds, selectedWorktrees]
  )

  const updateSelectionForArea = useCallback(
    (
      areaIds: readonly string[],
      additive: boolean,
      baseSelectedIds: ReadonlySet<string> = selectedWorktreeIds,
      baseAnchorId: string | null = selectionAnchorId
    ): void => {
      const result = updateWorktreeAreaSelection({
        visibleIds: boardWorktreeIds,
        previousSelectedIds: baseSelectedIds,
        previousAnchorId: baseAnchorId,
        areaIds,
        additive
      })
      setSelectedWorktreeIds((previous) =>
        areWorktreeSelectionsEqual(previous, result.selectedIds) ? previous : result.selectedIds
      )
      setSelectionAnchorId((previous) =>
        previous === result.anchorId ? previous : result.anchorId
      )
    },
    [boardWorktreeIds, selectedWorktreeIds, selectionAnchorId]
  )

  const clearSelection = useCallback(() => {
    setSelectedWorktreeIds((previous) => (previous.size === 0 ? previous : new Set()))
    setSelectionAnchorId((previous) => (previous === null ? previous : null))
  }, [])

  return {
    selectedWorktreeIds,
    selectedWorktrees,
    selectionAnchorId,
    updateSelectionForGesture,
    updateSelectionForArea,
    clearSelection,
    selectForContextMenu
  }
}
