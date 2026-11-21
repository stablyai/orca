import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { buildMirroredAgentStatusPatch } from '../agent-status/agent-status-patch'
import {
  buildRemirroredClosedTabMarkerLiftPatch,
  buildRetractedMirroredTabSweepPatch
} from '../agent-status/agent-status-primitives'
import { collectCollidingRetractionPaneKeys } from '../agent-status/retraction-pane-ownership'
import { adoptFrameDrawnClientHostedBrowserHandles } from './frame-drawn-desktop-browser-handles'
import { isWebSessionTabsWorktreeRemovalFrame } from '../tracking/session-tabs-inventory-absence'
import { hostSnapshotAffirmsWorktreeContents } from '../hydration/host-session-snapshot-authority'
import { removeTabsAttention } from '../../../store/slices/workspace-attention/subject-attention-transitions'
import type { WebSessionTabsBatchContext, WebSessionTabsSyncState } from '../state'
import { buildMirroredTerminalTabs } from '../tab-projection/terminal-build'
import {
  isMirroredTerminalSurfaceId,
  isTerminalSurfaceTab
} from '../tab-projection/terminal-surfaces'

/** Apply status/unread and newly created client-page handles only; layout frames own tabs, layout, bindings and focus. */
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
  // Frames may remove retracted tabs before or after the host snapshot; inspect both.
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
  // Hide retired tabs only for the sweep, which requires absence; frames may still hold them.
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

  // Layout frames may already have dropped the row; still retire its markers only when this frame affirms the close.
  const attention =
    !removalFrame && hostSnapshotAffirmsWorktreeContents(snapshot)
      ? removeTabsAttention(
          {
            unreadTerminalTabs: state.unreadTerminalTabs,
            unreadTerminalPanes: state.unreadTerminalPanes ?? {},
            unreadAgentCompletionPanes: state.unreadAgentCompletionPanes ?? {}
          },
          retractedTabIds
        )
      : null
  const nextUnreadTerminalTabs = attention?.unreadTerminalTabs ?? state.unreadTerminalTabs
  const nextUnreadTerminalPanes = attention?.unreadTerminalPanes ?? state.unreadTerminalPanes
  const nextUnreadAgentCompletionPanes =
    attention?.unreadAgentCompletionPanes ?? state.unreadAgentCompletionPanes

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
      : {}),
    ...(nextUnreadTerminalPanes !== state.unreadTerminalPanes
      ? { unreadTerminalPanes: nextUnreadTerminalPanes }
      : {}),
    ...(nextUnreadAgentCompletionPanes !== state.unreadAgentCompletionPanes
      ? { unreadAgentCompletionPanes: nextUnreadAgentCompletionPanes }
      : {})
  }
  return Object.keys(patch).length === 0 ? state : patch
}
