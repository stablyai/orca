import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import {
  type PaneCloseKind,
  takePaneCloseIntent,
  takePaneMountUnfocused
} from '@/runtime/layout-owner-pane-intents'
import { planTerminalLiveLayoutInsertions } from './terminal-live-layout-reconciliation'
import { collectLeafIds } from '../../../../shared/terminal-pane-layout-tree'

/**
 * A layout-owner build's mounted tab drawn from main's tree (the store's layout, which frames set).
 * Every pane main added is mounted, whoever split it: main starts its terminal, and the pane
 * attaches to it. The window's own close shows here with the close it asked for; a pane main
 * dropped without one is left to main's notice. Then the panes take main's shape (by moving,
 * never recreating) and ratios. True when panes were added or closed.
 */
export function reconcileMountedPanesToLayout(args: {
  tabId: string
  manager: PaneManager
  layout: TerminalLayoutSnapshot
  /** The window's own close of a pane main closed: its terminal, status and pane go. */
  closePane: (paneId: number, leafId: string, kind: PaneCloseKind) => void
  /** A zoomed pane hides its siblings; their shape and ratios wait until it collapses. */
  isExpanded: boolean
}): boolean {
  const { tabId, manager, layout } = args
  const root = layout.root
  if (!root) {
    return false
  }
  const target = new Set(collectLeafIds(root))
  let changed = false

  for (const pane of manager.getPanes()) {
    const kind = target.has(pane.leafId) ? null : takePaneCloseIntent(tabId, pane.leafId)
    // The window's last pane stays: main's tree then holds a pane the window lacks (a split whose
    // source went), which main's notice brings; never a tab with no pane.
    if (kind && manager.getPanes().length > 1) {
      args.closePane(pane.id, pane.leafId, kind)
      changed = true
    }
  }

  const mounted = manager.getPanes().map((pane) => pane.leafId)
  for (const insertion of planTerminalLiveLayoutInsertions(root, mounted)) {
    const sourcePaneId = manager.getNumericIdForLeaf(insertion.sourceLeafId)
    if (sourcePaneId === null || manager.getNumericIdForLeaf(insertion.newLeafId) !== null) {
      continue
    }
    const ratio =
      insertion.ratio === undefined
        ? undefined
        : insertion.placement === 'before'
          ? 1 - insertion.ratio
          : insertion.ratio
    const ptyId = layout.ptyIdsByLeafId?.[insertion.newLeafId]
    const activeBefore = manager.getActivePane()
    const created = manager.splitPaneAroundLeafIds(
      insertion.sourceLeafIds,
      sourcePaneId,
      insertion.direction,
      {
        leafId: insertion.newLeafId,
        placement: insertion.placement,
        ...(ratio !== undefined && { ratio }),
        // Bound already: the pane attaches to main's terminal; unbound, it waits on main's start.
        ...(ptyId ? { ptyId } : {})
      }
    )
    if (created) {
      changed = true
      // As switch-off's startup split: the new pane mounts, focus stays on the source pane.
      if (activeBefore && takePaneMountUnfocused(tabId, insertion.newLeafId)) {
        const hadFocus = created.container.contains(document.activeElement)
        manager.setActivePane(activeBefore.id, { focus: hadFocus })
      }
    }
  }

  if (args.isExpanded) {
    return changed
  }
  // Ratios, or another client's move: the same panes move into main's shape, none recreated.
  manager.applyLayoutGeometry(root, true)
  return changed
}
