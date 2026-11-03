import type { AppState } from '../../../types'
import { removeTabsAttention } from '../../workspace-attention/subject-attention-transitions'
import type { createWorktreePurgeOmitters } from './worktree-purge-omitters'

type WorktreePurgeOmitters = ReturnType<typeof createWorktreePurgeOmitters>

/** The paneKey-keyed sleeping maps after the caller's own omission policy. */
export type WorktreePurgeSleepingMaps = Pick<
  AppState,
  'sleepingAgentSessionsByPaneKey' | 'agentLaunchConfigByPaneKey'
>

/** Tab-, PTY-, pane-, page- and file-keyed state of purged surfaces; never a worktree-keyed bucket. */
export function buildWorktreePurgeSurfacePatch(
  s: AppState,
  omitters: WorktreePurgeOmitters,
  doomedTabIds: ReadonlySet<string>,
  sleeping: WorktreePurgeSleepingMaps,
  changedPaneKeys?: Set<string>
): Partial<AppState> {
  const {
    omitByTabId,
    omitByPtyId,
    omitByPaneKeyTabPrefix,
    omitByBrowserWorkspaceId,
    omitByPageId,
    omitByFileId
  } = omitters
  const nextAgentStatusByPaneKey = omitByPaneKeyTabPrefix(s.agentStatusByPaneKey, changedPaneKeys)
  return {
    localOnlyScrollbackByTabId: omitByTabId(s.localOnlyScrollbackByTabId),
    runtimePaneTitlesByTabId: omitByTabId(s.runtimePaneTitlesByTabId),
    automaticAgentResumeClaimsByTabId: omitByTabId(s.automaticAgentResumeClaimsByTabId),
    nativeChatLaunchPromptByTabId: omitByTabId(s.nativeChatLaunchPromptByTabId),
    nativeChatLaunchDraftByTabId: omitByTabId(s.nativeChatLaunchDraftByTabId),
    // Why: bulk/hydration purge runs no terminal teardown, so it must drop the per-tab pane-expand flags itself.
    expandedPaneByTabId: omitByTabId(s.expandedPaneByTabId),
    canExpandPaneByTabId: omitByTabId(s.canExpandPaneByTabId),
    // Bulk/reconcile/project/hydration purges skip single-removal teardown and must evict terminal caches here.
    lastKnownRelayPtyIdByTabId: omitByTabId(s.lastKnownRelayPtyIdByTabId),
    // Reconnect maps prove orphan-sweep liveness; clear them or recreated IDs inherit phantom sessions.
    pendingReconnectPtyIdByTabId: omitByTabId(s.pendingReconnectPtyIdByTabId),
    unverifiedPtyLossTabIds: omitByTabId(s.unverifiedPtyLossTabIds),
    deferredSshSessionIdsByTabId: omitByTabId(s.deferredSshSessionIdsByTabId),
    pendingInitialCwdByTabId: omitByTabId(s.pendingInitialCwdByTabId),
    pendingIssueCommandSplitByTabId: omitByTabId(s.pendingIssueCommandSplitByTabId),
    pendingStartupByTabId: omitByTabId(s.pendingStartupByTabId),
    codexRestartNoticeByPtyId: omitByPtyId(s.codexRestartNoticeByPtyId),
    migrationUnsupportedByPtyId: omitByPtyId(s.migrationUnsupportedByPtyId),
    suppressedPtyExitIds: omitByPtyId(s.suppressedPtyExitIds),
    pendingPaneAccountRestarts: omitByPtyId(s.pendingPaneAccountRestarts),
    // Evict bulk-purged agent/unread/input state; retainedAgents and orchestration self-heal via pruning/full sync.
    agentStatusByPaneKey: nextAgentStatusByPaneKey,
    ...(nextAgentStatusByPaneKey !== s.agentStatusByPaneKey
      ? { agentStatusEpoch: s.agentStatusEpoch + 1 }
      : {}),
    agentLaunchConfigByPaneKey: sleeping.agentLaunchConfigByPaneKey,
    acknowledgedAgentsByPaneKey: omitByPaneKeyTabPrefix(s.acknowledgedAgentsByPaneKey),
    activityClearedAtByPaneKey: omitByPaneKeyTabPrefix(s.activityClearedAtByPaneKey),
    manuallyUnreadTurnsByPaneKey: omitByPaneKeyTabPrefix(s.manuallyUnreadTurnsByPaneKey),
    paneForegroundAgentByPaneKey: omitByPaneKeyTabPrefix(s.paneForegroundAgentByPaneKey),
    sleepingAgentSessionsByPaneKey: sleeping.sleepingAgentSessionsByPaneKey,
    ...removeTabsAttention(s, doomedTabIds),
    lastTerminalInputAtByPaneKey: omitByPaneKeyTabPrefix(s.lastTerminalInputAtByPaneKey),
    browserPagesByWorkspace: omitByBrowserWorkspaceId(s.browserPagesByWorkspace),
    browserAnnotationsByPageId: omitByPageId(s.browserAnnotationsByPageId),
    browserAnnotationMarkerIdsByPageId: omitByPageId(s.browserAnnotationMarkerIdsByPageId),
    remoteBrowserPageHandlesByPageId: omitByPageId(s.remoteBrowserPageHandlesByPageId),
    pendingAddressBarFocusByPageId: omitByPageId(s.pendingAddressBarFocusByPageId),
    // createBrowserTab writes both the workspace id and the page id into this map.
    pendingAddressBarFocusByTabId: omitByPageId(
      omitByBrowserWorkspaceId(s.pendingAddressBarFocusByTabId)
    ),
    recentlyClosedBrowserPagesByWorkspace: omitByBrowserWorkspaceId(
      s.recentlyClosedBrowserPagesByWorkspace
    ),
    editorDrafts: omitByFileId(s.editorDrafts),
    markdownViewMode: omitByFileId(s.markdownViewMode),
    markdownRichModeSizeOverride: omitByFileId(s.markdownRichModeSizeOverride),
    markdownFrontmatterVisible: omitByFileId(s.markdownFrontmatterVisible),
    editorCursorLine: omitByFileId(s.editorCursorLine),
    editorViewMode: omitByFileId(s.editorViewMode)
  }
}
