import React, { useCallback, useEffect, useMemo, useState } from 'react'
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

  useEffect(() => {
    if (!open) {
      setSelectedWorktreeIds(new Set())
      setSelectionAnchorId(null)
      return
    }

    setSelectedWorktreeIds((previous) => {
      const pruned = pruneWorktreeSelection(previous, selectionAnchorId, boardWorktreeIds)
      if (pruned.anchorId !== selectionAnchorId) {
        setSelectionAnchorId(pruned.anchorId)
      }
      return areWorktreeSelectionsEqual(previous, pruned.selectedIds)
        ? previous
        : pruned.selectedIds
    })
  }, [boardWorktreeIds, open, selectionAnchorId])

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

  return {
    selectedWorktreeIds,
    selectedWorktrees,
    selectionAnchorId,
    updateSelectionForGesture,
    updateSelectionForArea,
    selectForContextMenu
  }
}
