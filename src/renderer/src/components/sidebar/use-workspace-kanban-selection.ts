import React, { useCallback, useMemo, useState } from 'react'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  areWorktreeSelectionsEqual,
  getWorktreeSelectionIntent,
  pruneWorktreeSelection,
  updateWorktreeAreaSelection,
  updateWorktreeSelection
} from './worktree-multi-selection'

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

// Why: board search hides cards without dropping them from the board, so range
// and area gestures index the rendered subset while pruning still spans the
// whole board — a card hidden by a query keeps its selection until a gesture
// replaces it, and every action path narrows to the rendered cards anyway.
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
      // Why: a search can hide the anchor while leaving the rest of the
      // selection on screen. updateWorktreeSelection reads an anchor missing
      // from visibleIds as "no anchor" and collapses the range to the click,
      // so re-anchor onto the first still-rendered selected card instead.
      const anchorId =
        intent === 'range' && selectionAnchorId !== null
          ? (resolveRenderedAnchorId(renderedWorktreeIds, selectedWorktreeIds, selectionAnchorId) ??
            selectionAnchorId)
          : selectionAnchorId
      const result = updateWorktreeSelection({
        visibleIds: renderedWorktreeIds,
        previousSelectedIds: selectedWorktreeIds,
        previousAnchorId: anchorId,
        targetId: worktreeId,
        intent
      })
      // Why: a range replaces the selection, exactly like a plain click and a
      // non-additive marquee. Carrying hidden cards through it would leave the
      // user with a selection they cannot see, count, or narrow.
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
      const result = updateWorktreeAreaSelection({
        visibleIds: renderedWorktreeIds,
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
