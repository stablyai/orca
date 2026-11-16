import type { WorkspaceVisibleTabType } from '../../../../../shared/tab-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../../../shared/workspace-session/workspace-session-state-types'
import { pruneLocalTerminalScrollbackBuffers } from '../../../../../shared/workspace-session/workspace-session-terminal-buffers'
import { normalizeBrowserHistoryEntries } from '../../../../../shared/workspace-session/workspace-session-browser-history'
import { normalizeWorkspaceDocHistoryEntries } from '../../../../../shared/workspace-session/workspace-doc-history'
import type { AppState } from '../../../store/types'
import type { OpenFile } from '../../../store/slices/editor/types/open-file'
import { buildPersistedUnifiedTabSessionData } from './workspace-session-unified-tabs'
import { buildLastVisitedAtByWorktreeId } from './workspace-session-focus-recency'
import { buildSleepingAgentSessionData } from './workspace-session-sleeping-agents'
import { buildActiveConnectionIdsAtShutdown } from './workspace-session-reconnect-targets'
import { withoutStagedBrowserTabs } from './workspace-session-staged-browser-tabs'
import { buildBrowserSessionData } from './workspace-session-browser-tabs'
import { pickCloseIntents, type CloseIntentFields } from './workspace-session-close-intents'
import {
  buildSanitizedTabsByWorktree,
  buildTerminalSessionData
} from './workspace-session-terminal-data'
import { withStrandedEditorDrafts, type StrandedEditorDrafts } from './stranded-editor-drafts'

/** Why (issue #1158): require both flags so a hydration failure can't overwrite orca-data.json with empty error-path state. */
export function shouldPersistWorkspaceSession(
  state: Pick<AppState, 'workspaceSessionReady' | 'hydrationSucceeded'>
): boolean {
  return state.workspaceSessionReady && state.hydrationSucceeded
}

export type WorkspaceSessionSnapshot = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorkspaceKey'
  | 'activeWorktreeId'
  | 'activeTabId'
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'localOnlyScrollbackByTabId'
  | 'activeTabIdByWorktree'
  | 'openFiles'
  | 'editorDrafts'
  | 'markdownFrontmatterVisible'
  | 'activeFileIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'browserTabsByWorktree'
  | 'browserPagesByWorkspace'
  | 'browserAnnotationsByPageId'
  | 'activeBrowserTabIdByWorktree'
  | 'browserUrlHistory'
  | 'workspaceDocHistory'
  | 'remoteBrowserPageHandlesByPageId'
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'activeGroupIdByWorktree'
  | 'sshConnectionStates'
  | 'repos'
  | 'worktreesByRepo'
  | 'lastKnownRelayPtyIdByTabId'
  | 'lastVisitedAtByWorktreeId'
  | 'defaultTerminalTabsAppliedByWorktreeId'
> &
  CloseIntentFields & {
    activeWorkspaceExecutionHostId?: AppState['activeWorkspaceExecutionHostId']
    sleepingAgentSessionsByPaneKey?: AppState['sleepingAgentSessionsByPaneKey']
    /** Optional so the many partial snapshot fixtures keep type-checking; see buildTerminalSessionData. */
    pendingReconnectPtyIdByTabId?: AppState['pendingReconnectPtyIdByTabId']
    deferredSshSessionIdsByTabId?: AppState['deferredSshSessionIdsByTabId']
    strandedEditorDrafts?: AppState['strandedEditorDrafts']
  }

// Why: shallow-equality gate for the debounced session writer; _exhaustive below keeps it in sync with the snapshot type.
export const SESSION_RELEVANT_FIELDS = [
  'activeRepoId',
  'activeWorkspaceKey',
  'activeWorkspaceExecutionHostId',
  'activeWorktreeId',
  'activeTabId',
  'tabsByWorktree',
  'ptyIdsByTabId',
  'terminalLayoutsByTabId',
  'localOnlyScrollbackByTabId',
  'activeTabIdByWorktree',
  'openFiles',
  'editorDrafts',
  'markdownFrontmatterVisible',
  'activeFileIdByWorktree',
  'activeTabTypeByWorktree',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'browserAnnotationsByPageId',
  'activeBrowserTabIdByWorktree',
  'browserUrlHistory',
  'workspaceDocHistory',
  'remoteBrowserPageHandlesByPageId',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'activeGroupIdByWorktree',
  'sshConnectionStates',
  'repos',
  'worktreesByRepo',
  'lastKnownRelayPtyIdByTabId',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId',
  'sleepingAgentSessionsByPaneKey',
  'clientHostedBrowserCloseIntentsByEnvironment',
  'pairedTerminalTabCloseIntentsByEnvironment',
  'pendingReconnectPtyIdByTabId',
  'deferredSshSessionIdsByTabId',
  'strandedEditorDrafts'
] as const satisfies readonly (keyof WorkspaceSessionSnapshot)[]

type _MissingSessionField = Exclude<
  keyof WorkspaceSessionSnapshot,
  (typeof SESSION_RELEVANT_FIELDS)[number]
>
void (true satisfies [_MissingSessionField] extends [never] ? true : never)

/** Build the editor-file portion of the workspace session for persistence.
 *  Only edit-mode files are saved — diffs and conflict views are transient. */
export function buildEditorSessionData(
  openFiles: OpenFile[],
  editorDrafts: Record<string, string>,
  markdownFrontmatterVisible: Record<string, boolean>,
  activeFileIdByWorktree: Record<string, string | null>,
  activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType>,
  strandedEditorDrafts: StrandedEditorDrafts = {}
): Pick<
  WorkspaceSessionState,
  | 'openFilesByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'markdownFrontmatterVisible'
> {
  const editFiles = openFiles.filter((f) => f.mode === 'edit')
  const byWorktree: Record<string, PersistedOpenFile[]> = {}
  const editFileIdsByWorktree: Record<string, Set<string>> = {}
  for (const f of editFiles) {
    const arr = byWorktree[f.worktreeId] ?? (byWorktree[f.worktreeId] = [])
    // Why: never persist a dirty draft for a read-only tab — restoring one would reintroduce writable/hot-exit state for an agent transcript.
    const dirtyDraftContent = f.isDirty && f.readOnly !== true ? editorDrafts[f.id] : undefined
    arr.push({
      filePath: f.filePath,
      relativePath: f.relativePath,
      worktreeId: f.worktreeId,
      language: f.language,
      isPreview: f.isPreview || undefined,
      runtimeEnvironmentId: f.runtimeEnvironmentId,
      ...(f.mirroredFromRuntimeSession === true ? { mirroredFromRuntimeSession: true } : {}),
      externalSshTargetId: f.externalSshTargetId,
      // Why: persist readOnly only when true; absence is the writable default on restore.
      ...(f.readOnly === true ? { readOnly: true } : {}),
      ...(f.readOnly === true && f.liveTail === true ? { liveTail: true } : {}),
      ...(dirtyDraftContent !== undefined ? { dirtyDraftContent } : {}),
      // Why: baseline travels with the draft so restore can detect a changed-on-disk conflict before autosave clobbers an offline agent write.
      ...(dirtyDraftContent !== undefined && f.lastKnownDiskSignature
        ? { lastKnownDiskSignature: f.lastKnownDiskSignature }
        : {})
    })
    const ids =
      editFileIdsByWorktree[f.worktreeId] ?? (editFileIdsByWorktree[f.worktreeId] = new Set())
    ids.add(f.id)
  }

  const activeFileEntries: [string, string][] = []
  for (const [worktreeId, fileId] of Object.entries(activeFileIdByWorktree)) {
    if (fileId && editFileIdsByWorktree[worktreeId]?.has(fileId)) {
      activeFileEntries.push([worktreeId, fileId])
    }
  }
  const persistedActiveFileIdByWorktree = Object.fromEntries(activeFileEntries) as Record<
    string,
    string
  >

  const activeTabTypeEntries: [string, WorkspaceVisibleTabType][] = []
  for (const [worktreeId, tabType] of Object.entries(activeTabTypeByWorktree)) {
    if (tabType !== 'editor') {
      activeTabTypeEntries.push([worktreeId, tabType])
      continue
    }
    // Why: only keep the "editor" marker when it points at a restored file, else startup has no real editor tab to select.
    if (persistedActiveFileIdByWorktree[worktreeId]) {
      activeTabTypeEntries.push([worktreeId, tabType])
    }
  }
  const persistedActiveTabTypeByWorktree = Object.fromEntries(activeTabTypeEntries) as Record<
    string,
    WorkspaceVisibleTabType
  >
  const allEditFileIds = new Set(Object.values(editFileIdsByWorktree).flatMap((ids) => [...ids]))
  // Why: preserve the value so per-file hide overrides survive restart (map only carries `false`; visible is the default).
  const persistedMarkdownFrontmatterVisible = Object.fromEntries(
    Object.entries(markdownFrontmatterVisible ?? {}).filter(([fileId]) =>
      allEditFileIds.has(fileId)
    )
  )

  return {
    // Why: the window rebuilds this field wholesale, so drafts it could not restore are written back.
    openFilesByWorktree: withStrandedEditorDrafts(byWorktree, strandedEditorDrafts),
    activeFileIdByWorktree: persistedActiveFileIdByWorktree,
    activeTabTypeByWorktree: persistedActiveTabTypeByWorktree,
    markdownFrontmatterVisible: persistedMarkdownFrontmatterVisible
  }
}

export function buildWorkspaceSessionPayload(
  fullSnapshot: WorkspaceSessionSnapshot
): WorkspaceSessionState {
  const snapshot = withoutStagedBrowserTabs(fullSnapshot)
  const terminalSessionData = buildTerminalSessionData(snapshot)

  const payload = {
    activeRepoId: snapshot.activeRepoId,
    activeWorkspaceKey: snapshot.activeWorkspaceKey,
    activeWorkspaceExecutionHostId: snapshot.activeWorkspaceExecutionHostId,
    activeWorktreeId: snapshot.activeWorktreeId,
    activeTabId: snapshot.activeTabId,
    tabsByWorktree: buildSanitizedTabsByWorktree(snapshot.tabsByWorktree),
    terminalLayoutsByTabId: snapshot.terminalLayoutsByTabId,
    localOnlyScrollbackByTabId: snapshot.localOnlyScrollbackByTabId,
    // Why: session:set fully replaces the persisted object, so dropping this silently disables eager terminal reconnect on restart.
    activeWorktreeIdsOnShutdown: terminalSessionData.activeWorktreeIdsOnShutdown,
    activeTabIdByWorktree: snapshot.activeTabIdByWorktree,
    ...buildEditorSessionData(
      snapshot.openFiles,
      snapshot.editorDrafts,
      snapshot.markdownFrontmatterVisible,
      snapshot.activeFileIdByWorktree,
      snapshot.activeTabTypeByWorktree,
      snapshot.strandedEditorDrafts
    ),
    ...buildBrowserSessionData(
      snapshot.browserTabsByWorktree,
      snapshot.browserPagesByWorkspace,
      snapshot.activeBrowserTabIdByWorktree,
      snapshot.remoteBrowserPageHandlesByPageId,
      snapshot.browserAnnotationsByPageId
    ),
    // Why: enforce the history storage cap here so stale renderer state can't make every write stringify an oversized legacy array.
    browserUrlHistory: normalizeBrowserHistoryEntries(snapshot.browserUrlHistory),
    workspaceDocHistory: normalizeWorkspaceDocHistoryEntries(snapshot.workspaceDocHistory ?? []),
    // Why: persist only layouts backed by real tabs so a reload can't restore a blank split pane from the split-before-tab midpoint.
    ...buildPersistedUnifiedTabSessionData(snapshot),
    activeConnectionIdsAtShutdown: buildActiveConnectionIdsAtShutdown(
      snapshot,
      terminalSessionData.remoteSessionIdsByTabId ?? null
    ),
    remoteSessionIdsByTabId: terminalSessionData.remoteSessionIdsByTabId,
    // Why: omit when empty so builds that never stamped focus-recency don't bloat the payload. See docs/cmd-j-empty-query-ordering.md.
    lastVisitedAtByWorktreeId: buildLastVisitedAtByWorktreeId(snapshot),
    defaultTerminalTabsAppliedByWorktreeId:
      snapshot.defaultTerminalTabsAppliedByWorktreeId &&
      Object.keys(snapshot.defaultTerminalTabsAppliedByWorktreeId).length > 0
        ? snapshot.defaultTerminalTabsAppliedByWorktreeId
        : undefined,
    ...buildSleepingAgentSessionData(snapshot),
    ...pickCloseIntents(snapshot)
  }

  return pruneLocalTerminalScrollbackBuffers(payload, snapshot.repos)
}
