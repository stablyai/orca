import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react'
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

export type WorkspaceKanbanSelection = {
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  selectionAnchorId: string | null
  updateSelectionForGesture: (event: React.MouseEvent<HTMLElement>, worktreeId: string) => boolean
  updateSelectionForArea: (
    areaIds: readonly string[],
    additive: boolean,
    baseSelectedIds?: ReadonlySet<string>,
    baseAnchorId?: string | null
  ) => void
  clearSelection: () => void
  selectForContextMenu: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
}

// Why: board search hides cards without dropping them from the board, so range
// and area gestures index the rendered subset while pruning still spans the
// whole board — a card hidden by a query keeps its selection until a gesture
// replaces it, and every action path narrows to the rendered cards anyway.
export function useWorkspaceKanbanSelection(
  open: boolean,
  boardWorktrees: readonly Worktree[],
  renderedWorktrees: readonly Worktree[] = boardWorktrees
): WorkspaceKanbanSelection {
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

  // Why memo: derive pruned selection during render so children never receive or commit IDs no longer present on the board (retaining query-hidden cards), without executing setState in the render body.
  const prunedSelection = useMemo(
    () =>
      open
        ? pruneWorktreeSelection(selectedWorktreeIds, selectionAnchorId, boardWorktreeIds)
        : { selectedIds: new Set<string>(), anchorId: null },
    [boardWorktreeIds, open, selectedWorktreeIds, selectionAnchorId]
  )
  const effectiveSelectedWorktreeIds = prunedSelection.selectedIds
  const effectiveSelectionAnchorId = prunedSelection.anchorId

  const selectedWorktrees = useMemo(
    () =>
      boardWorktrees.filter((worktree) =>
        effectiveSelectedWorktreeIds.has(getWorktreeHostIdentity(worktree))
      ),
    [boardWorktrees, effectiveSelectedWorktreeIds]
  )

  // Why layout effect: synchronize pruned state back to local state after commit if filtering dropped selected cards, using equality guards.
  useLayoutEffect(() => {
    if (!areWorktreeSelectionsEqual(selectedWorktreeIds, effectiveSelectedWorktreeIds)) {
      setSelectedWorktreeIds(effectiveSelectedWorktreeIds)
    }
    if (selectionAnchorId !== effectiveSelectionAnchorId) {
      setSelectionAnchorId(effectiveSelectionAnchorId)
    }
  }, [
    boardWorktreeIds,
    effectiveSelectedWorktreeIds,
    effectiveSelectionAnchorId,
    open,
    selectedWorktreeIds,
    selectionAnchorId
  ])

  const updateSelectionForGesture = useCallback(
    (event: React.MouseEvent<HTMLElement>, worktreeId: string): boolean => {
      const intent = getWorktreeSelectionIntent(event, navigator.userAgent.includes('Mac'))
      // Why: a search can hide the anchor while leaving the rest of the
      // selection on screen. updateWorktreeSelection reads an anchor missing
      // from visibleIds as "no anchor" and collapses the range to the click,
      // so re-anchor onto the first still-rendered selected card instead.
      const anchorId =
        intent === 'range' && effectiveSelectionAnchorId !== null
          ? (resolveRenderedAnchorId(
              renderedWorktreeIds,
              effectiveSelectedWorktreeIds,
              effectiveSelectionAnchorId
            ) ?? effectiveSelectionAnchorId)
          : effectiveSelectionAnchorId
      const result = updateWorktreeSelection({
        visibleIds: renderedWorktreeIds,
        previousSelectedIds: effectiveSelectedWorktreeIds,
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
    [effectiveSelectedWorktreeIds, effectiveSelectionAnchorId, renderedWorktreeIds]
  )

  const selectForContextMenu = useCallback(
    (_event: React.MouseEvent<HTMLElement>, worktree: Worktree): readonly Worktree[] => {
      const worktreeIdentity = getWorktreeHostIdentity(worktree)
      if (
        effectiveSelectedWorktreeIds.has(worktreeIdentity) &&
        effectiveSelectedWorktreeIds.size > 1
      ) {
        return selectedWorktrees
      }
      setSelectedWorktreeIds(new Set([worktreeIdentity]))
      setSelectionAnchorId(worktreeIdentity)
      return [worktree]
    },
    [effectiveSelectedWorktreeIds, selectedWorktrees]
  )

  const updateSelectionForArea = useCallback(
    (
      areaIds: readonly string[],
      additive: boolean,
      baseSelectedIds: ReadonlySet<string> = effectiveSelectedWorktreeIds,
      baseAnchorId: string | null = effectiveSelectionAnchorId
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
    [effectiveSelectedWorktreeIds, effectiveSelectionAnchorId, renderedWorktreeIds]
  )

  const clearSelection = useCallback(() => {
    setSelectedWorktreeIds((previous) => (previous.size === 0 ? previous : new Set()))
    setSelectionAnchorId((previous) => (previous === null ? previous : null))
  }, [])

  return {
    selectedWorktreeIds: effectiveSelectedWorktreeIds,
    selectedWorktrees,
    selectionAnchorId: effectiveSelectionAnchorId,
    updateSelectionForGesture,
    updateSelectionForArea,
    clearSelection,
    selectForContextMenu
  }
}
