import { buildWebSessionExistingTabIndex } from '../web-session-existing-tab-index'
import { chooseTargetGroupId, buildHostGroupIdByTabId } from './tab-group-layout-tree'
import {
  buildMirroredBrowserTabs,
  browserWorkspaceHasRemoteEnvironmentPage,
  browserWorkspaceHasClientHostedEnvironmentPage
} from './mirrored-browser-tabs'
import { buildMirroredEditorTabs } from './tab-builders'
import { buildMirroredAgentTabs, isReadyBrowserTab, isReadyEditorTab } from './terminal-surfaces'
import { hostSnapshotAffirmsClientHostedPages } from '../host-session-snapshot-authority'
import type { prepareWebSessionTabsSnapshotBase } from './apply-preparation-base'
import type { OpenFile } from '../../store/slices/editor'
import {
  advanceWebSessionOpenFilesIndex,
  firstOpenFileByIdForWorktree,
  sameOpenFiles,
  webSessionOpenFilesForWorktree
} from './state-equality-files'

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
    batchContext
  } = base
  const targetGroupId = chooseTargetGroupId(state, snapshot)
  const hostGroupIdByTabId = buildHostGroupIdByTabId(snapshot.tabGroups)
  const currentUnifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
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
        // Why: a staged tab holds a handle before its create RPC answers, and a restored tab holds
        // one rebuilt from disk before the relaunched host has republished the page. Neither
        // handle is evidence the host ever saw this snapshot's worktree, so absence proves
        // nothing — culling here would erase an optimistic tab mid-create or a restored tab a
        // recovering host is still about to hand back.
        if (
          (state.browserPagesByWorkspace[tab.id] ?? []).some((page) => {
            const handle = state.remoteBrowserPageHandlesByPageId[page.id]
            return handle?.staged === true || handle?.restoredFromSession === true
          })
        ) {
          return false
        }
        // Why: a runtime with nothing published for this worktree, or one that has restarted and not
        // yet taken its client-hosted pages back, answers with a frame that looks exactly like
        // "everything was closed". A page this desktop is still hosting outlives the runtime
        // process, so its own guest is the better evidence — hold the row and let adoption publish
        // it, rather than deleting a tab that is still rendering. The unreconciled flag is
        // host-bounded; the unpublished-worktree frame is not, and its hold lasts until the runtime
        // publishes that worktree at all.
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
    firstOpenFileByIdForWorktree(worktreeOpenFiles),
    existingTabIndex,
    hostGroupIdByTabId,
    targetGroupId,
    mirroredTerminalTabEntries.length + mirroredBrowserTabs.length,
    now
  )
  const mirroredAgentTabs = buildMirroredAgentTabs(
    snapshot,
    hostGroupIdByTabId,
    targetGroupId,
    mirroredTerminalTabEntries.length + mirroredBrowserTabs.length + mirroredEditorTabs.length,
    currentUnifiedTabs,
    now
  )
  const mirroredEditorFileIds = new Set(mirroredEditorTabs.map((entry) => entry.file.id))
  const mirroredEditorHostTabIds = new Set(mirroredEditorTabs.map((entry) => entry.hostTabId))
  const removedEditorFileIds = new Set(
    (reconcilesNonAgentTabs ? worktreeOpenFiles : [])
      .filter(
        (file) =>
          file.runtimeEnvironmentId === environmentId &&
          (file.mode === 'edit' || file.mode === 'markdown-preview') &&
          // Why: only cull host-mirrored tabs; locally opened files have no host counterpart, so their omission isn't a close signal.
          file.mirroredFromRuntimeSession === true &&
          !mirroredEditorFileIds.has(file.id)
      )
      .map((file) => file.id)
  )
  const isReplacedOpenFile = (file: OpenFile): boolean =>
    file.runtimeEnvironmentId === environmentId &&
    (removedEditorFileIds.has(file.id) || mirroredEditorFileIds.has(file.id))
  const replacedOpenFileCount = worktreeOpenFiles.filter(isReplacedOpenFile).length
  // Why: both consumers below ask only about this worktree, so the surviving ids answer
  // them in worktree scope instead of walking every open file in the app.
  const nextWorktreeOpenFileIds = new Set<string>(
    worktreeOpenFiles.filter((file) => !isReplacedOpenFile(file)).map((file) => file.id)
  )
  for (const fileId of mirroredEditorFileIds) {
    nextWorktreeOpenFileIds.add(fileId)
  }
  const mirroredOpenFiles = mirroredEditorTabs.map((entry) => entry.file)
  const nextOpenFiles = (() => {
    // Why: with nothing to drop or mirror, rebuilding reproduces the array exactly, so
    // skip the global rebuild the equality check below would have thrown away anyway.
    if (replacedOpenFileCount === 0 && mirroredOpenFiles.length === 0) {
      return state.openFiles
    }
    const retained = state.openFiles.filter(
      (file) =>
        !(
          file.worktreeId === worktreeId &&
          file.runtimeEnvironmentId === environmentId &&
          (removedEditorFileIds.has(file.id) || mirroredEditorFileIds.has(file.id))
        )
    )
    const next = [...retained, ...mirroredOpenFiles]
    return sameOpenFiles(state.openFiles, next) ? state.openFiles : next
  })()
  advanceWebSessionOpenFilesIndex(batchContext, nextOpenFiles, worktreeId)
  const retainedUnifiedTabs = currentUnifiedTabs.filter((tab) => {
    if (tab.contentType === 'agent-session') {
      return false
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
