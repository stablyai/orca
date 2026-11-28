import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../../../../../../shared/sidebar-list/row-types'
import {
  isActiveSidebarWorkspace,
  type ActiveSidebarWorkspace
} from '../../../../../../shared/sidebar-list/selection/active-workspace'
import {
  getRenderedWorkspaceRowsInSidebarOrder,
  type RenderedWorkspaceRow
} from './worktree-sidebar-row-preference'
import { getWorktreeExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  setVisibleWorktreeIds,
  setVisibleWorktreeShortcutTargets
} from '../listing/visible-worktrees'
import { useListMultiSelection } from '@/lib/list-interaction/use-list-multi-selection'
import { useReusedArrayIdentity } from '../listing/use-reused-array-identity'
import { useAppStore } from '@/store'
import { focusActiveWorkspaceSurfaceFromSidebar } from './focus-workspace-surface'

const getSidebarContainer = (): Element | null =>
  document.querySelector('[data-worktree-sidebar-container]')

export function useSidebarWorktreeSelection(args: {
  sectionRows: HostSectionRow[]
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  /** The workspace the cards draw as active; null worktreeId when none is (e.g. Tasks/Activity). */
  active: ActiveSidebarWorkspace
}) {
  const { sectionRows, pinnedDisplayPolicy, active } = args
  const { worktreeId: activeWorktreeId, hostId: activeHostId } = active
  // Built rows include grouping/pinning reorder; use their order for selection and Cmd+1–9 parity.
  const renderedRows = useMemo(
    () => getRenderedWorkspaceRowsInSidebarOrder(sectionRows, pinnedDisplayPolicy),
    [pinnedDisplayPolicy, sectionRows]
  )
  const { renderedWorktrees, repoByWorktree, uniqueWorktreeIds } = useMemo(() => {
    const worktrees: Worktree[] = []
    const repoMap = new Map<Worktree, RenderedWorkspaceRow['repo']>()
    const seenIds = new Set<string>()
    const ids: string[] = []
    for (const row of renderedRows) {
      worktrees.push(row.worktree)
      repoMap.set(row.worktree, row.repo)
      if (!seenIds.has(row.worktree.id)) {
        seenIds.add(row.worktree.id)
        ids.push(row.worktree.id)
      }
    }
    return { renderedWorktrees: worktrees, repoByWorktree: repoMap, uniqueWorktreeIds: ids }
  }, [renderedRows])
  const renderedWorktreeIds = useReusedArrayIdentity(uniqueWorktreeIds)
  const selection = useListMultiSelection({
    items: renderedWorktrees,
    getKey: getWorktreeHostIdentity,
    getScope: getSidebarContainer
  })
  const { updateSelectionForGesture: updateSelection } = selection
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const focusedWorktree =
    focusedKey !== null && selection.selectedKeys.has(focusedKey)
      ? (selection.getItemForKey(focusedKey) ?? null)
      : null
  const focusedWorkspaceExecutionHostId = focusedWorktree
    ? getWorktreeExecutionHostId(focusedWorktree, repoByWorktree.get(focusedWorktree))
    : null
  if (focusedKey !== null && focusedWorktree === null) {
    setFocusedKey(null)
  }
  const selectWorktree = useCallback(
    (worktree: Worktree) => {
      setFocusedKey(getWorktreeHostIdentity(worktree))
      updateSelection({ metaKey: false, ctrlKey: false, shiftKey: false }, worktree)
    },
    [updateSelection]
  )
  const updateSelectionForGesture = useCallback(
    (event: React.MouseEvent<HTMLElement>, worktree: Worktree): boolean => {
      setFocusedKey(getWorktreeHostIdentity(worktree))
      const selectionOnly = updateSelection(event, worktree)
      const list = event.currentTarget?.closest<HTMLElement>('[data-worktree-sidebar]')
      // Why: a plain click opens the workspace, whose terminal or chat takes the keys; only multi-select keeps them in the list.
      if (selectionOnly) {
        list?.focus({ preventScroll: true })
        list?.setAttribute('data-keyboard-navigation', '')
      } else if (list) {
        const { activeWorktreeId, activeWorkspaceExecutionHostId } = useAppStore.getState()
        // Re-clicking the open workspace activates nothing, so hand its surface the keys here.
        if (
          activeWorktreeId === worktree.id &&
          activeWorkspaceExecutionHostId ===
            getWorktreeExecutionHostId(worktree, repoByWorktree.get(worktree))
        ) {
          focusActiveWorkspaceSurfaceFromSidebar(list)
        }
      }
      return selectionOnly
    },
    [repoByWorktree, updateSelection]
  )
  const { selectedItems, setAllSelected } = selection
  const previousActiveRef = useRef(active)
  // Why: a plain click selects the open card; once a shortcut or palette opens another, drop that selection or the old card keeps its multi-select ring.
  useLayoutEffect(() => {
    const previous = previousActiveRef.current
    if (previous.worktreeId === activeWorktreeId && previous.hostId === activeHostId) {
      return
    }
    previousActiveRef.current = { worktreeId: activeWorktreeId, hostId: activeHostId }
    if (selectedItems.length === 1 && isActiveSidebarWorkspace(selectedItems[0], previous)) {
      setAllSelected(false)
    }
  }, [activeWorktreeId, activeHostId, selectedItems, setAllSelected])
  const { selectForContextMenu: selectItemForContextMenu } = selection
  // Why keep the event arg: kanban and list cards share the onContextMenuSelect prop shape.
  const selectForContextMenu = useCallback(
    (_event: React.MouseEvent<HTMLElement>, worktree: Worktree): readonly Worktree[] => {
      setFocusedKey(getWorktreeHostIdentity(worktree))
      return selectItemForContextMenu(worktree)
    },
    [selectItemForContextMenu]
  )

  // Why layout effect: the Cmd/Ctrl+1–9 handler can fire right after commit; publishing after paint would leave the shortcut cache stale.
  useLayoutEffect(() => {
    const chipKeysByIdentity = new Map<string, string>()
    for (const row of sectionRows) {
      if (row.type === 'item' && row.lineageGroupKey && row.lineageChildCount > 0) {
        chipKeysByIdentity.set(getWorktreeHostIdentity(row.worktree), row.lineageGroupKey)
      }
    }
    setVisibleWorktreeIds(renderedWorktreeIds)
    const hasLineageChips = chipKeysByIdentity.size > 0
    setVisibleWorktreeShortcutTargets(
      renderedWorktrees.map((worktree) => {
        const lineageGroupKey = hasLineageChips
          ? chipKeysByIdentity.get(getWorktreeHostIdentity(worktree))
          : undefined
        return {
          id: worktree.id,
          ...(worktree.hostId ? { executionHostId: worktree.hostId } : {}),
          ...(lineageGroupKey ? { lineageGroupKey } : {})
        }
      })
    )
    // Why null, not []: [] is a real rendered order (all collapsed/filtered); null tells shortcuts the list is unmounted.
    return () => {
      setVisibleWorktreeIds(null)
      setVisibleWorktreeShortcutTargets(null)
    }
  }, [renderedWorktreeIds, renderedWorktrees, sectionRows])

  return {
    renderedWorktreeIds,
    renderedWorktreeIdentities: selection.visibleKeys,
    selectedWorktreeIds: selection.selectedKeys,
    selectedWorktrees: selection.selectedItems,
    focusedWorktree,
    focusedWorkspaceExecutionHostId,
    selectWorktree,
    updateSelectionForGesture,
    selectForContextMenu
  }
}
