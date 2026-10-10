import { reuseArrayIfEqual } from '@/components/sidebar/worktree-agent-row-selectors'
import { sameBucketRecords } from '@/lib/bucket-record-equality'
import { sameStringRecord } from '@/lib/terminal-layout-equality'
import {
  type SnapshotCapabilityBindingState,
  type SnapshotCapabilityTab,
  collectTerminalProviderSnapshotPtyIds
} from './terminal-provider-snapshot-capability'

type TabsByWorktree = SnapshotCapabilityBindingState['tabsByWorktree']
type LayoutsByTabId = NonNullable<SnapshotCapabilityBindingState['terminalLayoutsByTabId']>

const EMPTY_TABS: TabsByWorktree = Object.freeze({})
const EMPTY_LAYOUTS: LayoutsByTabId = Object.freeze({})

function sameBoundTab(previous: SnapshotCapabilityTab, next: SnapshotCapabilityTab): boolean {
  return previous.id === next.id && previous.ptyId === next.ptyId
}

/** Leaf pty bindings are the only layout field the collector reads; active-leaf moves, pane titles
 *  and buffer captures all replace the layout object without touching them. */
function sameLayoutLeafPtyIds(previous: LayoutsByTabId, next: LayoutsByTabId): boolean {
  if (previous === next) {
    return true
  }
  const tabIds = Object.keys(next)
  if (tabIds.length !== Object.keys(previous).length) {
    return false
  }
  for (const tabId of tabIds) {
    const nextLayout = next[tabId]
    const previousLayout = previous[tabId]
    if (previousLayout === nextLayout) {
      continue
    }
    if (
      !previousLayout ||
      !sameStringRecord(previousLayout.ptyIdsByLeafId, nextLayout?.ptyIdsByLeafId)
    ) {
      return false
    }
  }
  return true
}

/**
 * Why: the collector walks every tab and every layout leaf, and the maps it reads are rewritten by
 * agent title frames and active-leaf moves that cannot alter the pty set. Gating it on the fields it
 * actually reads — `tab.id`, `tab.ptyId`, `ptyIdsByTabId`, `pendingReconnectPtyIdByTabId`,
 * `layout.ptyIdsByLeafId` — keeps those frames free, and reusing the prior array when a real rebuild
 * lands on the same set keeps the synchronization effect asleep.
 *
 * Why chaining against the immediately preceding state is enough: equality over those fields is
 * transitive, so a run of unchanged states is equivalent to comparing against the state that
 * produced the cached array.
 */
export function createTerminalProviderSnapshotBoundPtyIdsSelector(): (
  state: SnapshotCapabilityBindingState
) => string[] {
  let previousTabsByWorktree: TabsByWorktree = EMPTY_TABS
  let previousLayoutsByTabId: LayoutsByTabId = EMPTY_LAYOUTS
  let previousPtyIdsByTabId: SnapshotCapabilityBindingState['ptyIdsByTabId'] | undefined
  let previousPendingReconnectPtyIdByTabId: SnapshotCapabilityBindingState['pendingReconnectPtyIdByTabId']
  let boundPtyIds: string[] = []
  let collected = false

  return (state) => {
    const layoutsByTabId = state.terminalLayoutsByTabId ?? EMPTY_LAYOUTS
    const unchanged =
      collected &&
      previousPtyIdsByTabId === state.ptyIdsByTabId &&
      previousPendingReconnectPtyIdByTabId === state.pendingReconnectPtyIdByTabId &&
      sameBucketRecords(previousTabsByWorktree, state.tabsByWorktree, sameBoundTab) &&
      sameLayoutLeafPtyIds(previousLayoutsByTabId, layoutsByTabId)
    if (!unchanged) {
      boundPtyIds = reuseArrayIfEqual(
        boundPtyIds,
        collectTerminalProviderSnapshotPtyIds(state).sort()
      )
      previousPtyIdsByTabId = state.ptyIdsByTabId
      previousPendingReconnectPtyIdByTabId = state.pendingReconnectPtyIdByTabId
      collected = true
    }
    previousTabsByWorktree = state.tabsByWorktree
    previousLayoutsByTabId = layoutsByTabId
    return boundPtyIds
  }
}
