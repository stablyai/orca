import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
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

// Multi-select over the rows the sidebar actually rendered, so gestures, context menus, and
// the Cmd+1–9 shortcut cache all agree on one order.
export function useSidebarWorktreeSelection(args: {
  sectionRows: HostSectionRow[]
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
}) {
  const { sectionRows, pinnedDisplayPolicy, activeWorktreeId, activeWorkspaceExecutionHostId } =
    args
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

  const prunedSelection = pruneWorktreeSelection(
    selectedWorktreeIds,
    selectionAnchorId,
    renderedWorktreeIdentities
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
        const identity = getWorktreeHostIdentity(worktree)
        if (selectedWorktreeIds.has(identity) && !selected.has(identity)) {
          selected.set(identity, worktree)
        }
      }
      return Array.from(selected.values())
    }, [renderedWorktrees, selectedWorktreeIds])
  )

  // Resolved in the vocabulary the rows themselves carry, which is not always the one the
  // store names: activation resolves a host even for a local row, while withRepoHostOwnership
  // leaves that row unqualified. Composing the resolved host would publish an identity no row
  // has, and the render-phase prune would then drop the selection outright.
  const activeIdentity = useMemo(() => {
    if (!activeWorktreeId) {
      return null
    }
    if (activeWorkspaceExecutionHostId) {
      // Only when a row actually carries it — that is what disambiguates one id across hosts.
      const composed = composeWorktreeHostIdentity(activeWorkspaceExecutionHostId, activeWorktreeId)
      if (renderedWorktreeIdentities.includes(composed)) {
        return composed
      }
    }
    const activeWorktree = renderedWorktrees.find((worktree) => worktree.id === activeWorktreeId)
    return activeWorktree ? getWorktreeHostIdentity(activeWorktree) : null
  }, [
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    renderedWorktreeIdentities,
    renderedWorktrees
  ])

  // Keyed on what the store activated rather than on the resolved identity: the identity also
  // goes null when a filter or a collapsed group hides the active row, and a null there must
  // not read as "nothing has been activated yet".
  const activationKey = activeWorktreeId
    ? composeWorktreeHostIdentity(activeWorkspaceExecutionHostId ?? undefined, activeWorktreeId)
    : null
  // What the store last activated, and which identity was last written into the selection.
  // The flag is only meaningful once an identity has been adopted: it carries a move that
  // could not be written yet, which comparing those two values cannot express.
  const observedActivation = useRef<string | null | undefined>(undefined)
  const publishedIdentity = useRef<string | null>(null)
  const moveAwaitingPublish = useRef(false)
  // Why this exists: only mouse gestures ever wrote the selection, so activating a workspace
  // any other way (keyboard cycling, Cmd+digit, the palette, history) left the ring on the
  // card the user last clicked. A plain click activates *and* replaces the selection; every
  // other activation now agrees with it.
  //
  // Why a layout effect: an effect after paint would show the previous card's ring for a frame.
  useLayoutEffect(() => {
    // The store starts with no active workspace and hydration restores one after this hook
    // mounts, so nothing before the first adopted identity counts as a move. No flag check
    // here: the flag is only ever set below, under `!inStartup`, so it cannot be true while
    // no identity has been adopted.
    const inStartup = publishedIdentity.current === null
    const previousActivation = observedActivation.current
    observedActivation.current = activationKey
    if (!inStartup && previousActivation !== undefined && previousActivation !== activationKey) {
      // Remembered even when it cannot be published yet: a round trip through a workspace whose
      // row is hidden ends on the identity it started from, and only this flag still knows the
      // user moved twice.
      moveAwaitingPublish.current = true
    }
    if (!activeIdentity) {
      // A filter or a collapsed group is hiding the active row. The move keeps waiting.
      return
    }
    if (inStartup) {
      // Adopt what hydration restored without selecting it, so Cmd+click is not armed from a
      // card nobody picked.
      publishedIdentity.current = activeIdentity
      return
    }
    // The identity is compared too: discovery backfill can re-qualify a rendered row under an
    // unchanged activation, and the published identity would otherwise be pruned and lost.
    if (!moveAwaitingPublish.current && publishedIdentity.current === activeIdentity) {
      return
    }
    moveAwaitingPublish.current = false
    publishedIdentity.current = activeIdentity
    // Identity-preserving when it already matches, so a plain click does not re-render twice.
    setSelectedWorktreeIds((previousSelection) =>
      previousSelection.size === 1 && previousSelection.has(activeIdentity)
        ? previousSelection
        : new Set([activeIdentity])
    )
    setSelectionAnchorId(activeIdentity)
  }, [activationKey, activeIdentity])

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
    (event: React.MouseEvent<HTMLElement>, worktree: Worktree): boolean => {
      const worktreeIdentity = getWorktreeHostIdentity(worktree)
      const intent = getWorktreeSelectionIntent(event, navigator.userAgent.includes('Mac'))
      const result = updateWorktreeSelection({
        visibleIds: renderedWorktreeIdentities,
        previousSelectedIds: selectedWorktreeIds,
        previousAnchorId: selectionAnchorId,
        targetId: worktreeIdentity,
        intent
      })
      setSelectedWorktreeIds(result.selectedIds)
      setSelectionAnchorId(result.anchorId)
      // Plain click navigates; modifier gestures are selection-only so a batch can build without switching away.
      return intent !== 'replace'
    },
    [renderedWorktreeIdentities, selectedWorktreeIds, selectionAnchorId]
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
    selectedWorktreeIds,
    selectedWorktrees,
    updateSelectionForGesture,
    selectForContextMenu
  }
}
