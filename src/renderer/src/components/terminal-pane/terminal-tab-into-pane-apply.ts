import type { SplitTerminalPaneDetail } from '@/constants/terminal'
import type { TerminalLeafIntoTabRequest } from '../../../../shared/terminal-leaf-move'
import { graftLeafBeside } from '../../../../shared/terminal-layout-leaf-graft'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import {
  collectLayoutLeafIdsInOrder,
  layoutContainsLeafId,
  type PaneSide
} from '../../../../shared/workspace-layout/terminal-pane-tree'
import type { TerminalTabIntoPaneDeps } from './terminal-tab-into-pane-types'

// 'vertical' puts panes side by side, matching the layout tree's insertLeafBeside.
const SIDE_SPLIT: Record<
  PaneSide,
  Pick<SplitTerminalPaneDetail, 'direction'> & { placement: 'before' | 'after' }
> = {
  left: { direction: 'vertical', placement: 'before' },
  right: { direction: 'vertical', placement: 'after' },
  top: { direction: 'horizontal', placement: 'before' },
  bottom: { direction: 'horizontal', placement: 'after' }
}

/** The target layout with the moved leaf beside `targetLeafId`, or beside another leaf if that one left. */
function graftIntoTarget(
  deps: TerminalTabIntoPaneDeps,
  request: TerminalLeafIntoTabRequest,
  ptyId: string
): TerminalLayoutSnapshot | null {
  const store = deps.getStore()
  const { sourceTabId, targetTabId, leafId, targetLeafId, placement } = request
  const target = store.terminalLayoutsByTabId[targetTabId]
  if (!target) {
    return null
  }
  if (layoutContainsLeafId(target.root, leafId)) {
    return { ...target, ptyIdsByLeafId: { ...target.ptyIdsByLeafId, [leafId]: ptyId } }
  }
  const source = store.terminalLayoutsByTabId[sourceTabId]
  const fallbackTitle = Object.values(store.tabsByWorktree)
    .flat()
    .find((tab) => tab.id === sourceTabId)?.customTitle
  const base = { target, source, leafId, side: placement.side, ptyId, fallbackTitle }
  const anchor = layoutContainsLeafId(target.root, targetLeafId)
    ? targetLeafId
    : collectLayoutLeafIdsInOrder(target.root)[0]
  return anchor ? graftLeafBeside({ ...base, targetLeafId: anchor }) : null
}

/**
 * Applies a join main has committed: T's layout and PTY binding first, so S's close sees the PTY
 * as shared; then the mounted pane adopts it; S closes last. False when the target is gone here.
 */
export function applyTerminalTabJoin(
  deps: TerminalTabIntoPaneDeps,
  request: TerminalLeafIntoTabRequest,
  ptyId: string
): boolean {
  const { worktreeId, sourceTabId, targetTabId, leafId, targetLeafId, placement } = request
  // Only the mounted pane can collapse itself, and the split needs the others visible. Collapsing
  // saves the mounted tree, which has no moved leaf yet, so it must finish before the graft is saved.
  if (deps.getStore().expandedPaneByTabId[targetTabId]) {
    deps.dispatchToggleExpand(targetTabId)
  }
  const grafted = graftIntoTarget(deps, request, ptyId)
  if (!grafted) {
    return false
  }
  deps.getStore().setTabLayout(targetTabId, grafted)
  // T lists the PTY as a pane binding now, so S's close sees it as shared. The adopting pane makes
  // this same call; T's primary PTY stays and the relay hint becomes the last pane to bind.
  deps.getStore().updateTabPtyId(targetTabId, ptyId)
  deps.getStore().syncPaneMoveIntoTabPtyOwnership({
    movedLeafId: leafId,
    movedPtyId: ptyId,
    sourceTabId,
    targetTabId
  })
  const mounted = deps.mountedLeafIds(targetTabId)
  if (mounted) {
    const sourceLeafId = mounted.includes(targetLeafId)
      ? targetLeafId
      : mounted.find((id) => id !== leafId)
    if (sourceLeafId) {
      deps.dispatchSplit({
        tabId: targetTabId,
        worktreeId,
        paneRuntimeId: -1,
        sourceLeafId,
        newLeafId: leafId,
        ptyId,
        ...SIDE_SPLIT[placement.side]
      })
    }
    // The dispatch is fire-and-forget and its handler drops requests silently.
    if (!deps.mountedLeafIds(targetTabId)?.includes(leafId)) {
      deps.getStore().remountTerminalTabForRecovery(targetTabId)
    } else {
      // The split carries no title and pane creation does not show one; the layout copy alone
      // would appear only after a remount.
      const title = grafted.titlesByLeafId?.[leafId]
      if (title) {
        deps.dispatchPaneTitle({ tabId: targetTabId, leafId, title })
      }
    }
  }
  deps.getStore().closeTab(sourceTabId, {
    reason: 'cleanup',
    recordInteraction: false,
    captureRecentlyClosed: false,
    // Main already closed S, and T owns the PTY now.
    localPtyTeardownOwnedExternally: true
  })
  deps.resyncParkedWatchers(worktreeId, targetTabId)
  deps.scheduleGraphSync()
  const store = deps.getStore()
  store.setActiveTab(targetTabId)
  store.setActiveTabType('terminal', worktreeId)
  return true
}
