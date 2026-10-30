import { buildWebSessionExistingTabIndex } from '../web-session-existing-tab-index'
import { resolveWebSessionVisibleTabId } from '../web-session-focus-intent'
import { chooseTargetGroupId, buildHostGroupIdByTabId } from './tab-group-layout-tree'
import {
  buildMirroredBrowserTabs,
  browserWorkspaceHasRemoteEnvironmentPage,
  browserWorkspaceHasClientHostedEnvironmentPage
} from './mirrored-browser-tabs'
import { buildMirroredEditorTabs } from './tab-builders'
import { buildMirroredAgentTabs, isReadyBrowserTab, isReadyEditorTab } from './terminal-surfaces'
import {
  hostSnapshotAffirmsAgentSessions,
  hostSnapshotAffirmsClientHostedPages,
  hostSnapshotAffirmsWorktreeContents
} from '../host-session-snapshot-authority'
import type { prepareWebSessionTabsSnapshotBase } from './apply-preparation-base'
import type { OpenFile } from '../../store/slices/editor'
import {
  advanceWebSessionOpenFilesIndex,
  sameOpenFiles,
  webSessionOpenFilesForWorktree
} from './state-equality-files'
import { shouldRetainStructuredAgentSessionLaunchTab } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { executionHostIdForSessionTabsOwner } from '../local-structured-session-owner'
import { isAgentSessionTabOfAnotherHost } from './mirror-row-ownership'
import { isUnlistedCreatedChat } from '@/lib/structured-agent-session-unlisted-created-chats'

export function prepareWebSessionTabsSnapshotBrowser(
  base: ReturnType<typeof prepareWebSessionTabsSnapshotBase>
) {
  const {
    state,
    snapshot,
    environmentId,
    worktreeId,
    now,
    mirroredTerminalTabEntries,
    mirroredTerminalIds,
    removedTerminalIds,
    reconcilesNonAgentTabs,
    batchContext,
    navigationIntentTab
  } = base
  const targetGroupId = chooseTargetGroupId(state, snapshot)
  const hostGroupIdByTabId = buildHostGroupIdByTabId(snapshot.tabGroups)
  const currentUnifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const publishedAgentSessionIds = new Set(
    snapshot.tabs.filter((tab) => tab.type === 'agent-session').map((tab) => tab.sessionId)
  )
  // A chat this frame publishes or replaces is its to rebuild, whichever host last showed it.
  const claimedAgentSessionIds = new Set(publishedAgentSessionIds)
  for (const tab of snapshot.tabs) {
    if (tab.type === 'agent-session' && tab.replacesSessionId) {
      claimedAgentSessionIds.add(tab.replacesSessionId)
    }
  }
  const snapshotExecutionHostId = executionHostIdForSessionTabsOwner(environmentId)
  const agentSessionsAffirmed = hostSnapshotAffirmsAgentSessions(snapshot)
  const existingTabIndex = buildWebSessionExistingTabIndex({ unifiedTabs: currentUnifiedTabs })
  const readyBrowserTabs = reconcilesNonAgentTabs ? snapshot.tabs.filter(isReadyBrowserTab) : []
  const nextRemoteBrowserPageIds = new Set(readyBrowserTabs.map((tab) => tab.browserPageId))
  const mirroredBrowserTabs = buildMirroredBrowserTabs(
    snapshot,
    environmentId,
    state,
    hostGroupIdByTabId,
    targetGroupId,
    mirroredTerminalTabEntries.length,
    now
  )
  const mirroredBrowserWorkspaceIds = new Set(
    mirroredBrowserTabs.map((entry) => entry.workspace.id)
  )
  const currentBrowserTabs = state.browserTabsByWorktree[worktreeId] ?? []
  const removedBrowserWorkspaceIds = new Set(
    (reconcilesNonAgentTabs ? currentBrowserTabs : [])
      .filter((tab) => {
        if (mirroredBrowserWorkspaceIds.has(tab.id)) {
          return true
        }
        if (!browserWorkspaceHasRemoteEnvironmentPage(state, tab, environmentId)) {
          return false
        }
        // Staged/restored handles predate host proof; absence cannot cull optimistic creates or recovering pages before publication.
        if (
          (state.browserPagesByWorkspace[tab.id] ?? []).some((page) => {
            const handle = state.remoteBrowserPageHandlesByPageId[page.id]
            return handle?.staged === true || handle?.restoredFromSession === true
          })
        ) {
          return false
        }
        // Desktop guests survive runtime restart. Hold client-hosted rows until worktree publication or the bounded unreconciled flag clears; unpublished empty frames prove no close.
        if (
          !hostSnapshotAffirmsClientHostedPages(snapshot) &&
          browserWorkspaceHasClientHostedEnvironmentPage(state, tab, environmentId)
        ) {
          return false
        }
        return !(state.browserPagesByWorkspace[tab.id] ?? []).some((page) => {
          const handle = state.remoteBrowserPageHandlesByPageId[page.id]
          return (
            handle?.environmentId === environmentId &&
            nextRemoteBrowserPageIds.has(handle.remotePageId)
          )
        })
      })
      .map((tab) => tab.id)
  )
  const retainedBrowserTabs = currentBrowserTabs.filter(
    (tab) => !removedBrowserWorkspaceIds.has(tab.id)
  )
  const nextBrowserTabs =
    retainedBrowserTabs.length + mirroredBrowserTabs.length > 0
      ? [...retainedBrowserTabs, ...mirroredBrowserTabs.map((entry) => entry.workspace)]
      : null
  const readyEditorTabs = reconcilesNonAgentTabs ? snapshot.tabs.filter(isReadyEditorTab) : []
  const worktreeOpenFiles = webSessionOpenFilesForWorktree(state, worktreeId, batchContext)
  const mirroredEditorTabs = buildMirroredEditorTabs(
    snapshot,
    environmentId,
    state.openFiles,
    existingTabIndex,
    hostGroupIdByTabId,
    targetGroupId,
    mirroredTerminalTabEntries.length + mirroredBrowserTabs.length,
    now,
    (fileId) => state.editorDrafts?.[fileId] !== undefined,
    navigationIntentTab?.id ?? resolveWebSessionVisibleTabId(state, worktreeId)
  )
  const mirroredAgentTabs = buildMirroredAgentTabs(
    snapshot,
    executionHostIdForSessionTabsOwner(environmentId),
    hostGroupIdByTabId,
    targetGroupId,
    mirroredTerminalTabEntries.length + mirroredBrowserTabs.length + mirroredEditorTabs.length,
    currentUnifiedTabs,
    now
  )
  const mirroredEditorFileIds = new Set(mirroredEditorTabs.map((entry) => entry.file.id))
  const mirroredEditorHostTabIds = new Set(mirroredEditorTabs.map((entry) => entry.hostTabId))
  const mirroredOpenFiles = [
    ...new Map(mirroredEditorTabs.map((entry) => [entry.file.id, entry.file])).values()
  ]
  const mirroredFileRecords = new Set(mirroredOpenFiles)
  // A host that has not published this worktree yet proves nothing about its editor tabs.
  const reconcilesEditorFiles =
    reconcilesNonAgentTabs && hostSnapshotAffirmsWorktreeContents(snapshot)
  const removedEditorFileIds = new Set(
    (reconcilesEditorFiles ? worktreeOpenFiles : [])
      .filter(
        (file) =>
          file.runtimeEnvironmentId === environmentId &&
          (file.mode === 'edit' || file.mode === 'markdown-preview') &&
          // Cull only host-mirrored files; locally opened tabs have no host counterpart to list them.
          file.mirroredFromRuntimeSession === true &&
          !mirroredEditorFileIds.has(file.id)
      )
      .map((file) => file.id)
  )
  const isReplacedOpenFile = (file: OpenFile): boolean =>
    mirroredFileRecords.has(file) ||
    (file.runtimeEnvironmentId === environmentId &&
      (removedEditorFileIds.has(file.id) || mirroredEditorFileIds.has(file.id)))
  const replacedOpenFileCount = worktreeOpenFiles.filter(isReplacedOpenFile).length
  // Both consumers are worktree-scoped; use surviving IDs without walking global files.
  const nextWorktreeOpenFileIds = new Set<string>(
    worktreeOpenFiles.filter((file) => !isReplacedOpenFile(file)).map((file) => file.id)
  )
  for (const fileId of mirroredEditorFileIds) {
    nextWorktreeOpenFileIds.add(fileId)
  }
  const nextOpenFiles = (() => {
    // No drops or mirrors means identical output; skip the global rebuild equality would discard.
    if (replacedOpenFileCount === 0 && mirroredOpenFiles.length === 0) {
      return state.openFiles
    }
    const retained = state.openFiles.filter(
      (file) => !(file.worktreeId === worktreeId && isReplacedOpenFile(file))
    )
    const next = [...retained, ...mirroredOpenFiles]
    return sameOpenFiles(state.openFiles, next) ? state.openFiles : next
  })()
  advanceWebSessionOpenFilesIndex(batchContext, nextOpenFiles, worktreeId)
  const retainedUnifiedTabs = currentUnifiedTabs.filter((tab) => {
    if (tab.contentType === 'agent-session') {
      if (
        !claimedAgentSessionIds.has(tab.entityId) &&
        isAgentSessionTabOfAnotherHost(state, tab, snapshotExecutionHostId)
      ) {
        return true
      }
      // Matching host identity replaces provisional tabs immediately or both panes render before lifecycle publication.
      return (
        !publishedAgentSessionIds.has(tab.entityId) &&
        (!agentSessionsAffirmed ||
          shouldRetainStructuredAgentSessionLaunchTab(worktreeId, tab.entityId) ||
          isUnlistedCreatedChat(worktreeId, tab.entityId))
      )
    }
    if (tab.contentType === 'browser') {
      return (
        !removedBrowserWorkspaceIds.has(tab.entityId) &&
        !mirroredBrowserWorkspaceIds.has(tab.entityId)
      )
    }
    if (tab.contentType === 'editor') {
      return (
        !removedEditorFileIds.has(tab.entityId) &&
        !mirroredEditorFileIds.has(tab.entityId) &&
        !mirroredEditorHostTabIds.has(tab.id)
      )
    }
    if (tab.contentType !== 'terminal') {
      return true
    }
    if (removedTerminalIds.has(tab.entityId) || removedTerminalIds.has(tab.id)) {
      return false
    }
    return !mirroredTerminalIds.has(tab.entityId) && !mirroredTerminalIds.has(tab.id)
  })
  const existingViewModeByTabId = new Map(
    currentUnifiedTabs
      .filter((tab) => tab.contentType === 'terminal' && tab.viewMode)
      .map((tab) => [tab.id, tab.viewMode] as const)
  )
  return {
    ...base,
    targetGroupId,
    hostGroupIdByTabId,
    currentUnifiedTabs,
    existingTabIndex,
    readyBrowserTabs,
    nextRemoteBrowserPageIds,
    mirroredBrowserTabs,
    mirroredBrowserWorkspaceIds,
    currentBrowserTabs,
    removedBrowserWorkspaceIds,
    retainedBrowserTabs,
    nextBrowserTabs,
    readyEditorTabs,
    worktreeOpenFiles,
    mirroredEditorTabs,
    mirroredAgentTabs,
    mirroredEditorFileIds,
    mirroredEditorHostTabIds,
    removedEditorFileIds,
    nextWorktreeOpenFileIds,
    nextOpenFiles,
    retainedUnifiedTabs,
    existingViewModeByTabId
  }
}
