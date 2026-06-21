import type { WorkspaceSessionPatch, WorkspaceSessionState } from '../../../shared/types'
import { pruneLocalTerminalScrollbackBuffers } from '../../../shared/workspace-session-terminal-buffers'
import { normalizeBrowserHistoryEntries } from '../../../shared/workspace-session-browser-history'
import {
  buildActiveConnectionIdsAtShutdown,
  buildEditorSessionData,
  buildPersistedBrowserPagesByWorkspace,
  buildPersistedBrowserTabsByWorktree,
  buildSanitizedTabsByWorktree,
  buildTerminalSessionData,
  type WorkspaceSessionSnapshot
} from './workspace-session'
import { buildPersistedUnifiedTabSessionData } from './workspace-session-unified-tabs'
import { buildLastVisitedAtByWorktreeId } from './workspace-session-focus-recency'
import { buildSleepingAgentSessionData } from './workspace-session-sleeping-agents'

type SessionRelevantField = keyof WorkspaceSessionSnapshot

function hasAnyChangedField(
  changedFields: ReadonlySet<SessionRelevantField>,
  fields: readonly SessionRelevantField[]
): boolean {
  return fields.some((field) => changedFields.has(field))
}

function buildPrunedTerminalLayoutsByTabId(
  snapshot: WorkspaceSessionSnapshot
): WorkspaceSessionState['terminalLayoutsByTabId'] {
  return pruneLocalTerminalScrollbackBuffers(
    {
      activeRepoId: snapshot.activeRepoId,
      activeWorktreeId: snapshot.activeWorktreeId,
      activeTabId: snapshot.activeTabId,
      tabsByWorktree: snapshot.tabsByWorktree,
      terminalLayoutsByTabId: snapshot.terminalLayoutsByTabId
    },
    snapshot.repos
  ).terminalLayoutsByTabId
}

export function buildWorkspaceSessionPatch(
  snapshot: WorkspaceSessionSnapshot,
  changedFields: Iterable<SessionRelevantField>
): WorkspaceSessionPatch {
  const changed = new Set(changedFields)
  const patch: WorkspaceSessionPatch = {}

  if (changed.has('activeRepoId')) {
    patch.activeRepoId = snapshot.activeRepoId
  }
  if (changed.has('activeWorktreeId')) {
    patch.activeWorktreeId = snapshot.activeWorktreeId
  }
  if (changed.has('activeTabId')) {
    patch.activeTabId = snapshot.activeTabId
  }
  if (changed.has('tabsByWorktree')) {
    patch.tabsByWorktree = buildSanitizedTabsByWorktree(snapshot.tabsByWorktree)
  }
  if (hasAnyChangedField(changed, ['terminalLayoutsByTabId', 'tabsByWorktree', 'repos'] as const)) {
    patch.terminalLayoutsByTabId = buildPrunedTerminalLayoutsByTabId(snapshot)
  }
  if (changed.has('activeTabIdByWorktree')) {
    patch.activeTabIdByWorktree = snapshot.activeTabIdByWorktree
  }
  if (
    hasAnyChangedField(changed, [
      'tabsByWorktree',
      'ptyIdsByTabId',
      'lastKnownRelayPtyIdByTabId',
      'repos',
      'worktreesByRepo'
    ] as const)
  ) {
    Object.assign(patch, buildTerminalSessionData(snapshot))
  }
  if (changed.has('sshConnectionStates')) {
    patch.activeConnectionIdsAtShutdown = buildActiveConnectionIdsAtShutdown(snapshot)
  }
  if (
    hasAnyChangedField(changed, [
      'openFiles',
      'editorDrafts',
      'markdownFrontmatterVisible',
      'activeFileIdByWorktree',
      'activeTabTypeByWorktree'
    ] as const)
  ) {
    Object.assign(
      patch,
      buildEditorSessionData(
        snapshot.openFiles,
        snapshot.editorDrafts,
        snapshot.markdownFrontmatterVisible,
        snapshot.activeFileIdByWorktree,
        snapshot.activeTabTypeByWorktree
      )
    )
  }
  if (changed.has('browserTabsByWorktree')) {
    patch.browserTabsByWorktree = buildPersistedBrowserTabsByWorktree(
      snapshot.browserTabsByWorktree
    )
  }
  if (changed.has('browserPagesByWorkspace')) {
    patch.browserPagesByWorkspace = buildPersistedBrowserPagesByWorkspace(
      snapshot.browserPagesByWorkspace
    )
  }
  if (changed.has('activeBrowserTabIdByWorktree')) {
    patch.activeBrowserTabIdByWorktree = snapshot.activeBrowserTabIdByWorktree
  }
  if (changed.has('browserUrlHistory')) {
    patch.browserUrlHistory = normalizeBrowserHistoryEntries(snapshot.browserUrlHistory)
  }
  if (
    hasAnyChangedField(changed, [
      'activeGroupIdByWorktree',
      'groupsByWorktree',
      'layoutByWorktree',
      'unifiedTabsByWorktree'
    ] as const)
  ) {
    Object.assign(patch, buildPersistedUnifiedTabSessionData(snapshot))
  }
  if (changed.has('lastVisitedAtByWorktreeId')) {
    patch.lastVisitedAtByWorktreeId = buildLastVisitedAtByWorktreeId(snapshot)
  }
  if (changed.has('defaultTerminalTabsAppliedByWorktreeId')) {
    patch.defaultTerminalTabsAppliedByWorktreeId =
      snapshot.defaultTerminalTabsAppliedByWorktreeId &&
      Object.keys(snapshot.defaultTerminalTabsAppliedByWorktreeId).length > 0
        ? snapshot.defaultTerminalTabsAppliedByWorktreeId
        : undefined
  }
  if (changed.has('sleepingAgentSessionsByPaneKey')) {
    patch.sleepingAgentSessionsByPaneKey =
      buildSleepingAgentSessionData(snapshot).sleepingAgentSessionsByPaneKey
  }

  return patch
}
