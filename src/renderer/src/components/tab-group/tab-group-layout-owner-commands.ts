// A layout-owner build's tab moves and group sizes. A move: main places the tab first and its frame
// shows the move, or while its stream is down, the reconnect's snapshot does; the flush that shows
// it selects the tab, unless the user chose another selection since (L120).
// Group sizes: drawn while dragging, main saves the ratio when the drag ends.

import { useAppStore } from '@/store'
import type { TabSplitDirection } from '@/store/slices/tabs'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import type { WindowLayoutCommand } from '@/runtime/layout-apply-send'
import { isPaneColumnSplitDropNoOp } from '@/store/slices/pane-column-split-drop-no-op'
import { mirrorWebRuntimeTabMove } from '../tab-bar/web-runtime-tab-move-mirror'
import {
  expectMovedTabSelection,
  type MovedTabSelection
} from '@/runtime/layout-owner-pane-intents'
import { tabSelectionKey } from '@/store/slices/tabs/moved-tab-selection'
import { layoutFramesFlowing } from '@/runtime/layout-frame-position'
import { splitRatioIntentAt } from '../../../../shared/workspace-layout/split-ratio-intents'
import { tabOrderAnchor } from '../../../../shared/workspace-layout/tab-order'

/** A tab drop as the window resolved it: within its group, into another, or beside a group. */
export type TabDrop =
  | { kind: 'reorder'; tabId: string; groupId: string; tabOrder: string[] }
  | { kind: 'move'; tabId: string; groupId: string; index?: number }
  | { kind: 'split'; tabId: string; groupId: string; direction: TabSplitDirection }

/**
 * Sends a tab drop to main, which the window then shows; a refused drop moves nothing. False when
 * the window skips the drop or a paired server owns the workspace's layout: the caller moves the
 * tab as today.
 */
export function dropTabThroughLayoutOwner(worktreeId: string, drop: TabDrop): boolean {
  const command = commandFor(worktreeId, drop)
  if (!command) {
    return false
  }
  const forget = expectSelectionAfterMove(worktreeId, drop)
  const sent = sendLayoutCommandToOwner(worktreeId, command, {
    // The frame the answer waits for showed the move and the selection; with no stream, the
    // reconnect's snapshot will.
    apply: () => {
      if (layoutFramesFlowing()) {
        forget()
      }
    },
    asToday: () => {
      forget()
      moveAsToday(worktreeId, drop)
    },
    refused: forget
  })
  if (!sent) {
    forget()
  }
  return sent
}

/** Records that the moved tab is selected once a frame shows it out of its group. */
function expectSelectionAfterMove(worktreeId: string, drop: TabDrop): () => void {
  const state = useAppStore.getState()
  const fromGroupId = state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) => tab.id === drop.tabId
  )?.groupId
  if (drop.kind === 'reorder' || !fromGroupId) {
    return () => {}
  }
  const intent: MovedTabSelection = { worktreeId, tabId: drop.tabId, fromGroupId, selection: null }
  const forget = expectMovedTabSelection(intent)
  // Why a microtask: a drag's end restores its pre-drag selection right after the drop returns.
  queueMicrotask(() => {
    intent.selection = tabSelectionKey(useAppStore.getState(), worktreeId)
  })
  return forget
}

function commandFor(worktreeId: string, drop: TabDrop): WindowLayoutCommand | null {
  const { tabId, groupId } = drop
  const state = useAppStore.getState()
  const groups = state.groupsByWorktree[worktreeId] ?? []
  if (drop.kind === 'split') {
    const source = groups.find((candidate) => candidate.tabOrder.includes(tabId))
    // Why: a drop the window's own move skips changes nothing; main would still reset the ratio.
    if (
      !source ||
      isPaneColumnSplitDropNoOp({
        sourceGroupId: source.id,
        targetGroupId: groupId,
        splitDirection: drop.direction,
        sourceTabCount: source.tabOrder.length,
        layout: state.layoutByWorktree[worktreeId]
      })
    ) {
      return null
    }
    return { type: 'splitGroup', tabId, besideGroupId: groupId, direction: drop.direction }
  }
  const group = groups.find((candidate) => candidate.id === groupId)
  // Why: a move into the tab's own group moves nothing today (a paired client can send one).
  if (!group || (drop.kind === 'move' && group.tabOrder.includes(tabId))) {
    return null
  }
  const order = drop.kind === 'reorder' ? drop.tabOrder : group.tabOrder
  const index =
    drop.kind === 'reorder'
      ? drop.tabOrder.indexOf(tabId)
      : Math.min(drop.index ?? group.tabOrder.length, group.tabOrder.length)
  return {
    type: 'moveTab',
    tabId,
    toGroupId: groupId,
    index,
    afterTabId: tabOrderAnchor(order, index)
  }
}

/** Today's move, mirrored to a web client's server as today. */
function moveAsToday(worktreeId: string, drop: TabDrop): boolean {
  const state = useAppStore.getState()
  const { tabId, groupId: targetGroupId } = drop
  if (drop.kind === 'reorder') {
    // Why handled: main already moved the tab, or cannot.
    state.reorderUnifiedTabs(targetGroupId, drop.tabOrder, { layoutOwnerHandled: true })
    mirrorWebRuntimeTabMove({
      kind: 'reorder',
      worktreeId,
      tabId,
      targetGroupId,
      tabOrder: drop.tabOrder
    })
    return true
  }
  if (drop.kind === 'split') {
    const splitDirection = drop.direction
    const moved = state.dropUnifiedTab(tabId, { groupId: targetGroupId, splitDirection })
    if (moved) {
      mirrorWebRuntimeTabMove({ kind: 'split', worktreeId, tabId, targetGroupId, splitDirection })
    }
    return moved
  }
  const { index } = drop
  const moved = state.dropUnifiedTab(tabId, {
    groupId: targetGroupId,
    ...(index === undefined ? {} : { index })
  })
  if (moved) {
    mirrorWebRuntimeTabMove({ kind: 'move-to-group', worktreeId, tabId, targetGroupId, index })
  }
  return moved
}

/** Sets a group divider's ratio here, as today, then has main save that divider's ratio. */
export function setGroupRatioThroughLayoutOwner(
  worktreeId: string,
  nodePath: string,
  ratio: number
): void {
  const state = useAppStore.getState()
  state.setTabGroupSplitRatio(worktreeId, nodePath, ratio)
  const layout = useAppStore.getState().layoutByWorktree[worktreeId]
  // The window drew the ratio while dragging; main takes the divider's new ratio, not its tree,
  // and refuses it if that path now names another split (frames then redraw main's).
  const intent = layout && splitRatioIntentAt(layout, nodePath, ratio)
  if (intent && layout !== state.layoutByWorktree[worktreeId]) {
    const keep = (): void => {}
    sendLayoutCommandToOwner(
      worktreeId,
      { type: 'setGroupRatios', ratios: [intent] },
      { apply: keep, asToday: keep, drawn: true }
    )
  }
}
