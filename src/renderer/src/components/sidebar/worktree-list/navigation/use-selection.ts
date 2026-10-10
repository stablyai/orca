import { useCallback, useLayoutEffect, useMemo } from 'react'
import type React from 'react'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../grouping/row-types'
import { getRenderedWorktreesInSidebarOrder } from '../../worktree-sidebar-row-preference'
import { setVisibleWorktreeIds, setVisibleWorktreeShortcutTargets } from '../../visible-worktrees'
import { useListMultiSelection } from '@/hooks/use-list-multi-selection'
import { useReusedArrayIdentity } from '../listing/use-reused-array-identity'

const getSidebarContainer = (): Element | null =>
  document.querySelector('[data-worktree-sidebar-container]')

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
  const renderedWorktreeIds = useReusedArrayIdentity(
    useMemo(
      () => Array.from(new Set(renderedWorktrees.map((worktree) => worktree.id))),
      [renderedWorktrees]
    )
  )
  const selection = useListMultiSelection({
    items: renderedWorktrees,
    getKey: getWorktreeHostIdentity,
    getScope: getSidebarContainer
  })
  const { selectForContextMenu: selectItemForContextMenu } = selection
  // Why keep the event arg: kanban and list cards share the onContextMenuSelect prop shape.
  const selectForContextMenu = useCallback(
    (_event: React.MouseEvent<HTMLElement>, worktree: Worktree): readonly Worktree[] =>
      selectItemForContextMenu(worktree),
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
    setVisibleWorktreeShortcutTargets(
      renderedWorktrees.map((worktree) => {
        const lineageGroupKey = chipKeysByIdentity.get(getWorktreeHostIdentity(worktree))
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
    updateSelectionForGesture: selection.updateSelectionForGesture,
    selectForContextMenu
  }
}
