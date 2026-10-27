// Main frames/reconnect snapshots draw moves and select them unless selection changed; divider ratios persist on release.

import { useAppStore } from '@/store'
import type { TabSplitDirection } from '@/store/slices/tabs'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import type { WindowLayoutCommand } from '@/runtime/layout-apply-send'
import { isPaneColumnSplitDropNoOp } from '../../../../shared/workspace-layout/pane-column-split-drop-no-op'
import { mirrorWebRuntimeTabMove } from '../tab-bar/web-runtime-tab-move-mirror'
import {
  expectMovedTabSelection,
  type MovedTabSelection
} from '@/runtime/layout-owner-pane-intents'
import { tabSelectionKey } from '@/store/slices/tabs/moved-tab-selection'
import { layoutFramesFlowing } from '@/runtime/layout-frame-position'
import { splitRatioIntentAt } from '../../../../shared/workspace-layout/split-ratio-intents'
import { serverTabCount } from '@/lib/frame-drawn-desktop-created-tabs'
import { tabOrderAnchor } from '../../../../shared/workspace-layout/tab-order'

export type TabDrop =
  | { kind: 'reorder'; tabId: string; groupId: string; tabOrder: string[] }
  | { kind: 'move'; tabId: string; groupId: string; index?: number }
  | { kind: 'split'; tabId: string; groupId: string; direction: TabSplitDirection }

/** Send drops to main; refusal leaves tabs in place, while false delegates skipped or paired-server drops to the caller. */
export function dropTabThroughLayoutOwner(worktreeId: string, drop: TabDrop): boolean {
  const command = commandFor(worktreeId, drop)
  if (!command) {
    return false
  }
  const forget = expectSelectionAfterMove(worktreeId, drop)
  const sent = sendLayoutCommandToOwner(worktreeId, command, {
    // Forget after the answering frame; without a stream, retain selection intent for the reconnect snapshot.
    apply: (_result, origin) => {
      if (layoutFramesFlowing(origin.framesKey)) {
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

/** Select a moved tab when its frame arrives, unless the user selected elsewhere. */
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
    // Skip local no-ops before main can reset a split ratio.
    if (
      !source ||
      isPaneColumnSplitDropNoOp({
        sourceGroupId: source.id,
        targetGroupId: groupId,
        splitDirection: drop.direction,
        sourceTabCount: serverTabCount(worktreeId, source.tabOrder),
        layout: state.layoutByWorktree[worktreeId]
      })
    ) {
      return null
    }
    return { type: 'splitGroup', tabId, besideGroupId: groupId, direction: drop.direction }
  }
  const group = groups.find((candidate) => candidate.id === groupId)
  // Paired clients can request same-group moves, which must remain no-ops.
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

/** Apply the window-owned fallback and mirror it to the web runtime. */
function moveAsToday(worktreeId: string, drop: TabDrop): boolean {
  const state = useAppStore.getState()
  const { tabId, groupId: targetGroupId } = drop
  if (drop.kind === 'reorder') {
    // Mark ownership handled to avoid submitting the same reorder again.
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

/** Draw the ratio locally, then ask main to persist it. */
export function setGroupRatioThroughLayoutOwner(
  worktreeId: string,
  nodePath: string,
  ratio: number
): void {
  const state = useAppStore.getState()
  state.setTabGroupSplitRatio(worktreeId, nodePath, ratio)
  const layout = useAppStore.getState().layoutByWorktree[worktreeId]
  // Send split identity with the ratio so main refuses it if this path now names another split.
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
