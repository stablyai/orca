import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type React from 'react'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { HostSectionRow } from '../host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../worktree-list-groups'
import { getRenderedWorktreesInSidebarOrder } from '../worktree-sidebar-row-preference'
import { setVisibleWorktreeIds } from '../visible-worktrees'
import {
  areWorktreeSelectionsEqual,
  getWorktreeSelectionIntent,
  pruneWorktreeSelection,
  updateWorktreeSelection
} from '../worktree-multi-selection'
import { useReusedArrayIdentity } from './use-reused-array-identity'

function uniqueWorktreeIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids))
}

// Multi-select over the rows the sidebar actually rendered, so gestures, context menus, and
// the Cmd+1–9 shortcut cache all agree on one order.
export function useSidebarWorktreeSelection(args: {
  sectionRows: HostSectionRow[]
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
}) {
  const { sectionRows, pinnedDisplayPolicy } = args
  // Why: derive order from the built rows, not the flat worktrees array, so Cmd+1–9 match visual positions when grouping reorders cards.
  const renderedWorktrees = useMemo(
    () => getRenderedWorktreesInSidebarOrder(sectionRows, pinnedDisplayPolicy),
    [pinnedDisplayPolicy, sectionRows]
  )
  // Why: order-preserving sectionRows rebuilds must not give this array a new
  // identity — updateSelectionForGesture depends on it, and a fresh identity
  // there defeats React.memo bail-out for every WorktreeCard on epoch bumps.
  const renderedWorktreeIds = useReusedArrayIdentity(
    useMemo(
      () => uniqueWorktreeIds(renderedWorktrees.map((worktree) => worktree.id)),
      [renderedWorktrees]
    )
  )
  const [selectedWorktreeIds, setSelectedWorktreeIds] = useState<Set<string>>(new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)

  const prunedSelection = pruneWorktreeSelection(
    selectedWorktreeIds,
    selectionAnchorId,
    renderedWorktreeIds
  )
  // Why: filters/grouping can hide selected cards; prune during render so nothing sees stale ids for unrendered worktrees.
  if (!areWorktreeSelectionsEqual(selectedWorktreeIds, prunedSelection.selectedIds)) {
    setSelectedWorktreeIds(prunedSelection.selectedIds)
  }
  if (selectionAnchorId !== prunedSelection.anchorId) {
    setSelectionAnchorId(prunedSelection.anchorId)
  }

  // Why identity reuse: the empty/unchanged-selection case must keep one array
  // identity — selectForContextMenu and both drag-start handlers depend on
  // this array, and card memo bail-out depends on those staying stable.
  const selectedWorktrees = useReusedArrayIdentity(
    useMemo(() => {
      if (selectedWorktreeIds.size === 0) {
        return []
      }
      const selected = new Map<string, Worktree>()
      for (const worktree of renderedWorktrees) {
        if (selectedWorktreeIds.has(worktree.id) && !selected.has(worktree.id)) {
          selected.set(worktree.id, worktree)
        }
      }
      return Array.from(selected.values())
    }, [renderedWorktrees, selectedWorktreeIds])
  )

  useEffect(() => {
    if (selectedWorktreeIds.size === 0) {
      return
    }

    const clearSelectionOutsideSidebar = (event: PointerEvent): void => {
      const target = event.target
      const sidebarContainer = document.querySelector('[data-worktree-sidebar-container]')
      if (target instanceof Node && sidebarContainer?.contains(target)) {
        return
      }
      setSelectedWorktreeIds(new Set())
      setSelectionAnchorId(null)
    }

    document.addEventListener('pointerdown', clearSelectionOutsideSidebar, { capture: true })
    return () => {
      document.removeEventListener('pointerdown', clearSelectionOutsideSidebar, { capture: true })
    }
  }, [selectedWorktreeIds.size])

  const updateSelectionForGesture = useCallback(
    (event: React.MouseEvent<HTMLElement>, worktreeId: string): boolean => {
      const intent = getWorktreeSelectionIntent(event, navigator.userAgent.includes('Mac'))
      const result = updateWorktreeSelection({
        visibleIds: renderedWorktreeIds,
        previousSelectedIds: selectedWorktreeIds,
        previousAnchorId: selectionAnchorId,
        targetId: worktreeId,
        intent
      })
      setSelectedWorktreeIds(result.selectedIds)
      setSelectionAnchorId(result.anchorId)
      // Plain click navigates; modifier gestures are selection-only so a batch can build without switching away.
      return intent !== 'replace'
    },
    [renderedWorktreeIds, selectedWorktreeIds, selectionAnchorId]
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

  // Why layout effect: the Cmd/Ctrl+1–9 handler can fire right after commit; publishing after paint would leave the shortcut cache stale.
  useLayoutEffect(() => {
    setVisibleWorktreeIds(renderedWorktreeIds)
    // Why null, not []: [] is a real rendered order (all collapsed/filtered); null tells shortcuts the list is unmounted.
    return () => setVisibleWorktreeIds(null)
  }, [renderedWorktreeIds])

  return {
    renderedWorktreeIds,
    selectedWorktreeIds,
    selectedWorktrees,
    updateSelectionForGesture,
    selectForContextMenu
  }
}
