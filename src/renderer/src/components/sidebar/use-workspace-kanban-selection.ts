import React, { useCallback, useMemo, useState } from 'react'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  areSelectionsEqual,
  getSelectionIntent,
  pruneSelection,
  updateAreaSelection,
  updateSelection
} from '@/lib/list-multi-selection'

/** Returns the first still-rendered selected id, or `null` if the anchor is fine. */
function resolveRenderedAnchorId(
  renderedWorktreeIds: readonly string[],
  selectedWorktreeIds: ReadonlySet<string>,
  anchorId: string
): string | null {
  if (renderedWorktreeIds.includes(anchorId)) {
    return null
  }
  return renderedWorktreeIds.find((id) => selectedWorktreeIds.has(id)) ?? null
}

// Search preserves hidden selections until replacement; gestures and actions use only rendered cards.
export function useWorkspaceKanbanSelection(
  open: boolean,
  boardWorktrees: readonly Worktree[],
  renderedWorktrees: readonly Worktree[] = boardWorktrees
) {
  const boardWorktreeIds = useMemo(
    () => boardWorktrees.map(getWorktreeHostIdentity),
    [boardWorktrees]
  )
  const renderedWorktreeIds = useMemo(
    () => renderedWorktrees.map(getWorktreeHostIdentity),
    [renderedWorktrees]
  )
  const [selectedWorktreeIds, setSelectedWorktreeIds] = useState<Set<string>>(new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)
  const selectedWorktrees = useMemo(
    () =>
      boardWorktrees.filter((worktree) =>
        selectedWorktreeIds.has(getWorktreeHostIdentity(worktree))
      ),
    [boardWorktrees, selectedWorktreeIds]
  )

  if (!open) {
    if (selectedWorktreeIds.size > 0) {
      setSelectedWorktreeIds(new Set())
    }
    if (selectionAnchorId !== null) {
      setSelectionAnchorId(null)
    }
  } else if (selectedWorktreeIds.size > 0 || selectionAnchorId !== null) {
    const pruned = pruneSelection(selectedWorktreeIds, selectionAnchorId, boardWorktreeIds)
    // Prune missing IDs before children render a filtered or reordered board.
    if (!areSelectionsEqual(selectedWorktreeIds, pruned.selectedIds)) {
      setSelectedWorktreeIds(pruned.selectedIds)
    }
    if (selectionAnchorId !== pruned.anchorId) {
      setSelectionAnchorId(pruned.anchorId)
    }
  }

  const updateSelectionForGesture = useCallback(
    (event: React.MouseEvent<HTMLElement>, worktreeId: string): boolean => {
      const intent = getSelectionIntent(event, navigator.userAgent.includes('Mac'))
      // Reanchor ranges to a rendered selected card when search hides the original anchor.
      const anchorId =
        intent === 'range' && selectionAnchorId !== null
          ? (resolveRenderedAnchorId(renderedWorktreeIds, selectedWorktreeIds, selectionAnchorId) ??
            selectionAnchorId)
          : selectionAnchorId
      const result = updateSelection({
        visibleIds: renderedWorktreeIds,
        previousSelectedIds: selectedWorktreeIds,
        previousAnchorId: anchorId,
        targetId: worktreeId,
        intent
      })
      // Range gestures replace hidden selections just like plain clicks and non-additive marquees.
      setSelectedWorktreeIds(result.selectedIds)
      setSelectionAnchorId(result.anchorId)
      return intent !== 'replace'
    },
    [renderedWorktreeIds, selectedWorktreeIds, selectionAnchorId]
  )

  const selectForContextMenu = useCallback(
    (_event: React.MouseEvent<HTMLElement>, worktree: Worktree): readonly Worktree[] => {
      const worktreeIdentity = getWorktreeHostIdentity(worktree)
      if (selectedWorktreeIds.has(worktreeIdentity) && selectedWorktreeIds.size > 1) {
        return selectedWorktrees
      }
      setSelectedWorktreeIds(new Set([worktreeIdentity]))
      setSelectionAnchorId(worktreeIdentity)
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
      const result = updateAreaSelection({
        visibleIds: renderedWorktreeIds,
        previousSelectedIds: baseSelectedIds,
        previousAnchorId: baseAnchorId,
        areaIds,
        additive
      })
      setSelectedWorktreeIds((previous) =>
        areSelectionsEqual(previous, result.selectedIds) ? previous : result.selectedIds
      )
      setSelectionAnchorId((previous) =>
        previous === result.anchorId ? previous : result.anchorId
      )
    },
    [renderedWorktreeIds, selectedWorktreeIds, selectionAnchorId]
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
