import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { buildMirroredAgentStatusPatch } from './agent-status-patch'
import {
  buildRemirroredClosedTabMarkerLiftPatch,
  buildRetractedMirroredTabSweepPatch
} from './agent-status-primitives'
import { collectCollidingRetractionPaneKeys } from './retraction-pane-ownership'
import { adoptFrameDrawnClientHostedBrowserHandles } from './frame-drawn-desktop-browser-handles'
import { isWebSessionTabsWorktreeRemovalFrame } from './session-tabs-inventory-absence'
import type { WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'
import { writableWebSessionTabsRecord } from './state-equality-core'
import { buildMirroredTerminalTabs } from './terminal-build'
import { isMirroredTerminalSurfaceId, isTerminalSurfaceTab } from './terminal-surfaces'

/**
 * A frame-drawn workspace's share of one snapshot: agent status, unread markers, and the handles of
 * client-hosted pages this desktop created. Its tabs, layout, bindings and focus belong to the
 * layout frames, so none of those slices are written.
 */
export function buildFrameDrawnWorkspaceStatusPatch(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  worktreeId: string,
  previousSnapshotTabIds: ReadonlySet<string>,
  now: number,
  batchContext?: WebSessionTabsBatchContext
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const currentTerminalTabs = state.tabsByWorktree[worktreeId] ?? []
  const terminalSurfaceTabs = snapshot.tabs.filter(isTerminalSurfaceTab)
  const publishedTabIds = new Set(
    terminalSurfaceTabs.map((surface) => toWebTerminalSurfaceTabId(surface.parentTabId))
  )
  const removalFrame = isWebSessionTabsWorktreeRemovalFrame(snapshot)
  // Why both sources: frames may drop a retracted tab before or after the host's snapshot says so.
  const retractedTabIds = [
    ...new Set([
      ...previousSnapshotTabIds,
      ...currentTerminalTabs.map((tab) => tab.id).filter(isMirroredTerminalSurfaceId)
    ])
  ].filter((tabId) => !publishedTabIds.has(tabId))

  const retractionPaneKeys = collectCollidingRetractionPaneKeys(
    state,
    retractedTabIds,
    environmentId,
    worktreeId,
    batchContext
  )
  const agentStatusPatch = buildMirroredAgentStatusPatch(
    state,
    currentTerminalTabs,
    terminalSurfaceTabs,
    // Only consulted for pane bindings retained through a pruned leaf; never written.
    buildMirroredTerminalTabs(
      snapshot,
      environmentId,
      new Map(currentTerminalTabs.map((tab) => [tab.id, tab])),
      state.terminalLayoutsByTabId,
      state.ptyIdsByTabId,
      0,
      now
    ),
    environmentId,
    worktreeId,
    new Set(removalFrame ? [] : retractedTabIds),
    now,
    batchContext
  )
  const retiredTabs = new Set(retractedTabIds)
  // The sweep requires the retired tabs to be absent; frames may still hold them, so hide them here only.
  const sweepTabsByWorktree = {
    ...state.tabsByWorktree,
    [worktreeId]: currentTerminalTabs.filter((tab) => !retiredTabs.has(tab.id))
  }
  const retractedTabSweepPatch = removalFrame
    ? null
    : buildRetractedMirroredTabSweepPatch(
        state,
        sweepTabsByWorktree,
        agentStatusPatch,
        retractedTabIds,
        retractionPaneKeys,
        batchContext
      )
  const remirroredClosedTabLiftPatch = buildRemirroredClosedTabMarkerLiftPatch(
    retractedTabSweepPatch?.recentlyClosedAgentStatusTabIds ??
      state.recentlyClosedAgentStatusTabIds,
    publishedTabIds
  )

  let nextUnreadTerminalTabs = state.unreadTerminalTabs
  for (const tabId of retractedTabIds) {
    if (!nextUnreadTerminalTabs[tabId]) {
      continue
    }
    if (nextUnreadTerminalTabs === state.unreadTerminalTabs) {
      nextUnreadTerminalTabs = writableWebSessionTabsRecord(
        state,
        'unreadTerminalTabs',
        batchContext
      )
    }
    delete nextUnreadTerminalTabs[tabId]
  }

  const patch: Partial<WebSessionTabsSyncState> = {
    ...adoptFrameDrawnClientHostedBrowserHandles(
      state,
      snapshot,
      environmentId,
      worktreeId,
      batchContext
    ),
    ...agentStatusPatch,
    ...retractedTabSweepPatch,
    ...remirroredClosedTabLiftPatch,
    ...(nextUnreadTerminalTabs !== state.unreadTerminalTabs
      ? { unreadTerminalTabs: nextUnreadTerminalTabs }
      : {})
  }
  return Object.keys(patch).length === 0 ? state : patch
}
