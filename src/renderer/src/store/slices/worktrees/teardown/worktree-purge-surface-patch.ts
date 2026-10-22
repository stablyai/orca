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
  sleeping: WorktreePurgeSleepingMaps
): Partial<AppState> {
  const {
    omitByTabId,
    omitByPtyId,
    omitByPaneKeyTabPrefix,
    omitByBrowserWorkspaceId,
    omitByPageId,
    omitByFileId
  } = omitters
  const nextAgentStatusByPaneKey = omitByPaneKeyTabPrefix(s.agentStatusByPaneKey)
  return {
    localOnlyScrollbackByTabId: omitByTabId(s.localOnlyScrollbackByTabId),
    runtimePaneTitlesByTabId: omitByTabId(s.runtimePaneTitlesByTabId),
    automaticAgentResumeClaimsByTabId: omitByTabId(s.automaticAgentResumeClaimsByTabId),
    nativeChatLaunchPromptByTabId: omitByTabId(s.nativeChatLaunchPromptByTabId),
    nativeChatLaunchDraftByTabId: omitByTabId(s.nativeChatLaunchDraftByTabId),
    // Why: bulk/hydration purge runs no terminal teardown, so it must drop the per-tab pane-expand flags itself.
    expandedPaneByTabId: omitByTabId(s.expandedPaneByTabId),
    canExpandPaneByTabId: omitByTabId(s.canExpandPaneByTabId),
    // Why: these per-tab/per-pty terminal+agent maps evict on the single removeWorktree teardown path; the bulk reconcile / remove-project / hydration-stale paths run no teardown, so without these each strands an entry per tab/pane of externally-removed worktrees.
    lastKnownRelayPtyIdByTabId: omitByTabId(s.lastKnownRelayPtyIdByTabId),
    // Why: liveness-authoritative reconnect maps (orphan sweep reads them); drop purged tabs' entries here too so a re-materialized id can't inherit phantom liveness.
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
    // Why: these agent-status/unread/input maps clear only on the single removeWorktree teardown path; the bulk reconcile / remove-project / hydration-stale paths run no teardown, so without this they orphan an entry per agent pane (plus a phantom unread badge).
    // retainedAgentsByPaneKey and runtimeAgentOrchestrationByPaneKey are omitted here — both self-heal (pruneRetainedAgents on worktreesByRepo change; runtime map replaced wholesale each sync).
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
    // Browser state
    browserPagesByWorkspace: omitByBrowserWorkspaceId(s.browserPagesByWorkspace),
    // Why: keyed by page/workspace id, only cleaned by closeBrowserTab on the single-removal path; the bulk reconcile missed them, orphaning an entry per page of externally-removed worktrees.
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
    // Per-file editor state for removed files
    editorDrafts: omitByFileId(s.editorDrafts),
    markdownViewMode: omitByFileId(s.markdownViewMode),
    markdownRichModeSizeOverride: omitByFileId(s.markdownRichModeSizeOverride),
    markdownFrontmatterVisible: omitByFileId(s.markdownFrontmatterVisible),
    // Why: keyed by fileId; the bulk reconcile path previously kept these, leaking a cursor-line / view-mode entry per removed file.
    editorCursorLine: omitByFileId(s.editorCursorLine),
    editorViewMode: omitByFileId(s.editorViewMode)
  }
}
