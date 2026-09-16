import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type React from 'react'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../grouping/row-types'
import { getRenderedWorktreesInSidebarOrder } from '../../worktree-sidebar-row-preference'
import { setVisibleWorktreeIds, setVisibleWorktreeShortcutTargets } from '../../visible-worktrees'
import {
  areWorktreeSelectionsEqual,
  getWorktreeSelectionIntent,
  pruneWorktreeSelection,
  updateWorktreeSelection
} from '../../worktree-multi-selection'
import { useReusedArrayIdentity } from '../listing/use-reused-array-identity'

export type SidebarWorktreeSelection = {
  renderedWorktreeIds: readonly string[]
  renderedWorktreeIdentities: readonly string[]
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  updateSelectionForGesture: (event: React.MouseEvent<HTMLElement>, worktree: Worktree) => boolean
  selectForContextMenu: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
}

// Multi-select over the rows the sidebar actually rendered, so gestures, context menus, and
// the Cmd+1–9 shortcut cache all agree on one order.
export function useSidebarWorktreeSelection(args: {
  sectionRows: HostSectionRow[]
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
}): SidebarWorktreeSelection {
  const { sectionRows, pinnedDisplayPolicy } = args
  // Why: derive order from the built rows, not the flat worktrees array, so Cmd+1–9 match visual positions when grouping reorders cards.
  const renderedWorktrees = useMemo(
    () => getRenderedWorktreesInSidebarOrder(sectionRows, pinnedDisplayPolicy),
    [pinnedDisplayPolicy, sectionRows]
  )
  // Why: order-preserving sectionRows rebuilds must not give this array a new
  // identity — updateSelectionForGesture depends on it, and a fresh identity
  // there defeats React.memo bail-out for every WorktreeCard on epoch bumps.
  const renderedWorktreeIdentities = useReusedArrayIdentity(
    useMemo(
      () => Array.from(new Set(renderedWorktrees.map(getWorktreeHostIdentity))),
      [renderedWorktrees]
    )
  )
  const renderedWorktreeIds = useReusedArrayIdentity(
    useMemo(
      () => Array.from(new Set(renderedWorktrees.map((worktree) => worktree.id))),
      [renderedWorktrees]
    )
  )
  const [selectedWorktreeIds, setSelectedWorktreeIds] = useState<Set<string>>(new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)
  // Why memo: derive pruned selection during render so children never receive or commit stale unrendered IDs, without executing setState in the render body.
  const prunedSelection = useMemo(
    () =>
      pruneWorktreeSelection(selectedWorktreeIds, selectionAnchorId, renderedWorktreeIdentities),
    [renderedWorktreeIdentities, selectedWorktreeIds, selectionAnchorId]
  )
  const effectiveSelectedWorktreeIds = prunedSelection.selectedIds
  const effectiveSelectionAnchorId = prunedSelection.anchorId

  // Why layout effect: synchronize pruned state back to local state after commit if filtering dropped selected rows, using equality guards.
  useLayoutEffect(() => {
    if (!areWorktreeSelectionsEqual(selectedWorktreeIds, effectiveSelectedWorktreeIds)) {
      setSelectedWorktreeIds(effectiveSelectedWorktreeIds)
    }
    if (selectionAnchorId !== effectiveSelectionAnchorId) {
      setSelectionAnchorId(effectiveSelectionAnchorId)
    }
  }, [
    effectiveSelectedWorktreeIds,
    effectiveSelectionAnchorId,
    selectedWorktreeIds,
    selectionAnchorId
  ])
  // Why identity reuse: the empty/unchanged-selection case must keep one array
  // identity — selectForContextMenu and both drag-start handlers depend on
  // this array, and card memo bail-out depends on those staying stable.
  const selectedWorktrees = useReusedArrayIdentity(
    useMemo(() => {
      if (effectiveSelectedWorktreeIds.size === 0) {
        return []
      }
      const selected = new Map<string, Worktree>()
      for (const worktree of renderedWorktrees) {
        const identity = getWorktreeHostIdentity(worktree)
        if (effectiveSelectedWorktreeIds.has(identity) && !selected.has(identity)) {
          selected.set(identity, worktree)
        }
      }
      return Array.from(selected.values())
    }, [effectiveSelectedWorktreeIds, renderedWorktrees])
  )

  useEffect(() => {
    if (effectiveSelectedWorktreeIds.size === 0) {
      return
    }

    const clearSelectionOutsideSidebar = (event: PointerEvent): void => {
      const target = event.target
      const sidebarContainer = document.querySelector('[data-worktree-sidebar-container]')
      if (target instanceof Node && sidebarContainer?.contains(target)) {
        return
      }
      setSelectedWorktreeIds((previous) => (previous.size === 0 ? previous : new Set()))
      setSelectionAnchorId((previous) => (previous === null ? previous : null))
    }

    document.addEventListener('pointerdown', clearSelectionOutsideSidebar, { capture: true })
    return () => {
      document.removeEventListener('pointerdown', clearSelectionOutsideSidebar, { capture: true })
    }
  }, [effectiveSelectedWorktreeIds.size])

  const updateSelectionForGesture = useCallback(
    (event: React.MouseEvent<HTMLElement>, worktree: Worktree): boolean => {
      const worktreeIdentity = getWorktreeHostIdentity(worktree)
      const intent = getWorktreeSelectionIntent(event, navigator.userAgent.includes('Mac'))
      const result = updateWorktreeSelection({
        visibleIds: renderedWorktreeIdentities,
        previousSelectedIds: effectiveSelectedWorktreeIds,
        previousAnchorId: effectiveSelectionAnchorId,
        targetId: worktreeIdentity,
        intent
      })
      setSelectedWorktreeIds(result.selectedIds)
      setSelectionAnchorId(result.anchorId)
      // Plain click navigates; modifier gestures are selection-only so a batch can build without switching away.
      return intent !== 'replace'
    },
    [effectiveSelectedWorktreeIds, effectiveSelectionAnchorId, renderedWorktreeIdentities]
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
  // Why layout effect: the Cmd/Ctrl+1–9 handler can fire right after commit; publishing after paint would leave the shortcut cache stale.
  useLayoutEffect(() => {
    setVisibleWorktreeIds(renderedWorktreeIds)
    setVisibleWorktreeShortcutTargets(
      renderedWorktrees.map((worktree) => ({
        id: worktree.id,
        ...(worktree.hostId ? { executionHostId: worktree.hostId } : {})
      }))
    )
    // Why null, not []: [] is a real rendered order (all collapsed/filtered); null tells shortcuts the list is unmounted.
    return () => {
      setVisibleWorktreeIds(null)
      setVisibleWorktreeShortcutTargets(null)
    }
  }, [renderedWorktreeIds, renderedWorktrees])

  return {
    renderedWorktreeIds,
    renderedWorktreeIdentities,
    selectedWorktreeIds: effectiveSelectedWorktreeIds,
    selectedWorktrees,
    updateSelectionForGesture,
    selectForContextMenu
  }
}
