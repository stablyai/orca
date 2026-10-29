import type { SessionSourceEdit, OrdinarySourcePartial } from '../../../session-source-edits'
import type { WorktreePurgeDoomedIds } from './worktree-purge-doomed-ids'
import type { AppState } from '../../../types'
import { removeTabsAttention } from '../../workspace-attention/subject-attention-transitions'
import type { createWorktreePurgeOmitters } from './worktree-purge-omitters'

type WorktreePurgeOmitters = ReturnType<typeof createWorktreePurgeOmitters>

/** The paneKey-keyed sleeping maps after the caller's own omission policy. */
export type WorktreePurgeSleepingMaps = Pick<AppState, 'agentLaunchConfigByPaneKey'>

/** Tab-, PTY-, pane-, page- and file-keyed state of purged surfaces; never a worktree-keyed bucket. */
export function buildWorktreePurgeSurfacePatch(
  edit: SessionSourceEdit<AppState>,
  omitters: WorktreePurgeOmitters,
  doomed: WorktreePurgeDoomedIds,
  sleeping: WorktreePurgeSleepingMaps,
  changedPaneKeys?: Set<string>
): OrdinarySourcePartial<AppState> {
  const s = edit.view()
  const { doomedTabIds } = doomed
  const {
    omitByTabId,
    omitByPtyId,
    omitByPaneKeyTabPrefix,
    omitByBrowserWorkspaceId,
    omitByPageId,
    omitByFileId
  } = omitters
  edit.removeKeys('localOnlyScrollbackByTabId', doomedTabIds)
  edit.removeKeys('lastKnownRelayPtyIdByTabId', doomedTabIds)
  edit.removeKeys('pendingReconnectPtyIdByTabId', doomedTabIds)
  edit.removeKeys('deferredSshSessionIdsByTabId', doomedTabIds)
  edit.removeKeys('browserPagesByWorkspace', doomed.doomedBrowserWorkspaceIds)
  edit.removeKeys('remoteBrowserPageHandlesByPageId', doomed.doomedPageIds)
  edit.removeKeys('editorDrafts', doomed.removedFileIds)
  edit.removeKeys('markdownFrontmatterVisible', doomed.removedFileIds)
  const nextAgentStatusByPaneKey = omitByPaneKeyTabPrefix(s.agentStatusByPaneKey, changedPaneKeys)
  return {
    runtimePaneTitlesByTabId: omitByTabId(s.runtimePaneTitlesByTabId),
    automaticAgentResumeClaimsByTabId: omitByTabId(s.automaticAgentResumeClaimsByTabId),
    nativeChatLaunchPromptByTabId: omitByTabId(s.nativeChatLaunchPromptByTabId),
    nativeChatLaunchDraftByTabId: omitByTabId(s.nativeChatLaunchDraftByTabId),
    // Why: bulk/hydration purge runs no terminal teardown, so it must drop the per-tab pane-expand flags itself.
    expandedPaneByTabId: omitByTabId(s.expandedPaneByTabId),
    canExpandPaneByTabId: omitByTabId(s.canExpandPaneByTabId),
    // Bulk/reconcile/project/hydration purges skip single-removal teardown and must evict terminal caches here.
    // Reconnect maps prove orphan-sweep liveness; clear them or recreated IDs inherit phantom sessions.
    unverifiedPtyLossTabIds: omitByTabId(s.unverifiedPtyLossTabIds),
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
    ...removeTabsAttention(s, doomedTabIds),
    lastTerminalInputAtByPaneKey: omitByPaneKeyTabPrefix(s.lastTerminalInputAtByPaneKey),
    browserAnnotationsByPageId: omitByPageId(s.browserAnnotationsByPageId),
    browserAnnotationMarkerIdsByPageId: omitByPageId(s.browserAnnotationMarkerIdsByPageId),
    pendingAddressBarFocusByPageId: omitByPageId(s.pendingAddressBarFocusByPageId),
    // createBrowserTab writes both the workspace id and the page id into this map.
    pendingAddressBarFocusByTabId: omitByPageId(
      omitByBrowserWorkspaceId(s.pendingAddressBarFocusByTabId)
    ),
    recentlyClosedBrowserPagesByWorkspace: omitByBrowserWorkspaceId(
      s.recentlyClosedBrowserPagesByWorkspace
    ),
    markdownViewMode: omitByFileId(s.markdownViewMode),
    markdownRichModeSizeOverride: omitByFileId(s.markdownRichModeSizeOverride),
    editorCursorLine: omitByFileId(s.editorCursorLine),
    editorViewMode: omitByFileId(s.editorViewMode)
  }
}
