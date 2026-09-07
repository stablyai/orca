import { getSystemPrefersDark } from '@/lib/terminal-theme'
import type { AppState } from '@/store/types'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/runtime-types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  collectAmbiguousTerminalTabIds,
  graphState,
  jsonContentEquals,
  mobilePublicationEpoch
} from './graph-state'
import {
  buildMobileSessionAgentStatusByWorktree,
  buildMobileSessionWorktreeInputs,
  getOpenFileIndexes
} from './mobile-session-inputs'
import { getEditorDraftVersionByFileId } from './sync-projections'
import { getMobileTerminalTheme } from './mobile-terminal-theme'
import {
  isMobilePublishableBrowserWorkspace,
  isMobilePublishableOpenFile,
  isWebOnlyMirroredTerminalTab
} from './mobile-session-surfaces'
import {
  appendFallbackEditorTabsToGroups,
  buildMobileSessionGroupProjection,
  pruneTabGroupLayout
} from './mobile-session-group-projection'
import { buildMobileTerminalSurfaceTabs } from './mobile-session-terminal-tabs'
import { buildMobileMarkdownTab, buildMobileFileTab } from './mobile-session-editor-tabs'
import { buildMobileBrowserTab } from './mobile-session-browser-tabs'
import type { MobileSessionPublicationInputs } from './types'
import { canReuseMobileSessionSnapshot } from './mobile-session-capture'

export function buildMobileSessionTabSnapshots(
  state: AppState,
  systemPrefersDark = getSystemPrefersDark(),
  ambiguousTerminalTabIds: ReadonlySet<string> = collectAmbiguousTerminalTabIds(
    state.tabsByWorktree
  )
): RuntimeMobileSessionTabsSnapshot[] {
  const openFileIndexes = getOpenFileIndexes(state.openFiles)
  const browserTabsByWorktree = state.browserTabsByWorktree ?? {}
  const publicationInputs: MobileSessionPublicationInputs = {
    browserTabsByWorktree,
    openFileIndexes,
    editorDraftVersionByFileId: getEditorDraftVersionByFileId(state.editorDrafts),
    agentStatusByWorktreeId: buildMobileSessionAgentStatusByWorktree(
      state.agentStatusByPaneKey ?? {},
      state.tabsByWorktree
    ),
    generatedTitlesEnabled: state.settings?.tabAutoGenerateTitle === true,
    terminalTheme: getMobileTerminalTheme(state, systemPrefersDark)
  }
  const liveFolderWorkspaceIds = new Set(
    (state.folderWorkspaces ?? []).map((workspace) => workspace.id)
  )
  const worktreeIds = new Set<string>([
    ...Object.keys(state.tabsByWorktree),
    ...Object.keys(state.groupsByWorktree),
    ...Object.keys(state.unifiedTabsByWorktree),
    ...Object.keys(browserTabsByWorktree),
    ...state.openFiles.map((file) => file.worktreeId)
  ])
  const snapshots: RuntimeMobileSessionTabsSnapshot[] = []

  for (const worktreeId of worktreeIds) {
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (
      workspaceScope?.type === 'folder' &&
      !liveFolderWorkspaceIds.has(workspaceScope.folderWorkspaceId)
    ) {
      graphState.mobileSessionSnapshotCacheByWorktree.delete(worktreeId)
      continue
    }
    const inputs = buildMobileSessionWorktreeInputs(
      state,
      worktreeId,
      publicationInputs,
      ambiguousTerminalTabIds
    )
    const cached = graphState.mobileSessionSnapshotCacheByWorktree.get(worktreeId)
    if (cached && canReuseMobileSessionSnapshot(cached.inputs, inputs)) {
      snapshots.push(cached.snapshot)
      continue
    }
    const terminalTabById = new Map(inputs.terminalTabs.map((tab) => [tab.id, tab]))
    const browserWorkspaceById = new Map(
      inputs.browserWorkspaces.map((workspace) => [workspace.id, workspace])
    )
    const unifiedTabById = new Map(inputs.unifiedTabs.map((tab) => [tab.id, tab]))
    const openFilesForWorktree = inputs.openFilesById
    const editorIds = inputs.openFileIds.filter((fileId) => {
      const file = openFilesForWorktree?.get(fileId)
      return file ? isMobilePublishableOpenFile(file) : false
    })
    const terminalIds = [...terminalTabById.values()]
      .filter(
        (terminal) =>
          !isWebOnlyMirroredTerminalTab(terminal, inputs.terminalLayoutByTabId.get(terminal.id))
      )
      .map((terminal) => terminal.id)
    const groupProjection = buildMobileSessionGroupProjection(inputs, {
      terminalIds,
      editorIds,
      browserIds: [...browserWorkspaceById.values()]
        .filter(isMobilePublishableBrowserWorkspace)
        .map((workspace) => workspace.id)
    })
    const tabs: RuntimeMobileSessionSnapshotTab[] = []
    const emittedEditorFileIds = new Set<string>()
    const emittedEditorTabIds = new Set<string>()

    for (const item of groupProjection.order) {
      if (item.type === 'terminal') {
        const terminal = terminalTabById.get(item.id)
        if (
          !terminal ||
          isWebOnlyMirroredTerminalTab(terminal, inputs.terminalLayoutByTabId.get(terminal.id))
        ) {
          continue
        }
        tabs.push(...buildMobileTerminalSurfaceTabs(inputs, terminal, item.tabId))
      } else if (item.type === 'editor') {
        const file = openFilesForWorktree?.get(item.id)
        if (!file || !isMobilePublishableOpenFile(file)) {
          continue
        }
        const unifiedTab = item.tabId ? unifiedTabById.get(item.tabId) : undefined
        tabs.push(
          buildMobileMarkdownTab(inputs, file, unifiedTab) ??
            buildMobileFileTab(inputs, file, unifiedTab)
        )
        emittedEditorFileIds.add(file.id)
        emittedEditorTabIds.add(item.tabId ?? item.id)
      } else if (item.type === 'browser') {
        const workspace = browserWorkspaceById.get(item.id)
        if (!workspace || !isMobilePublishableBrowserWorkspace(workspace)) {
          continue
        }
        tabs.push(
          buildMobileBrowserTab(
            inputs,
            workspace,
            item.tabId ? unifiedTabById.get(item.tabId) : undefined
          )
        )
      }
    }

    const fallbackEditorTabs: { tabId: string; groupId: string | null }[] = []
    if (openFilesForWorktree) {
      const unifiedEditorTabs = inputs.unifiedTabs.filter(
        (tab) => tab.contentType === 'editor' || tab.contentType === 'diff'
      )
      const unifiedEditorFileIds = new Set(unifiedEditorTabs.map((tab) => tab.entityId))
      for (const unifiedTab of unifiedEditorTabs) {
        if (emittedEditorTabIds.has(unifiedTab.id)) {
          continue
        }
        const file = openFilesForWorktree.get(unifiedTab.entityId)
        if (!file || !isMobilePublishableOpenFile(file)) {
          continue
        }
        const fallbackTab =
          buildMobileMarkdownTab(inputs, file, unifiedTab) ??
          buildMobileFileTab(inputs, file, unifiedTab)
        tabs.push(fallbackTab)
        fallbackEditorTabs.push({ tabId: fallbackTab.id, groupId: unifiedTab.groupId })
        emittedEditorTabIds.add(unifiedTab.id)
      }
      for (const file of openFilesForWorktree.values()) {
        if (!isMobilePublishableOpenFile(file) || emittedEditorFileIds.has(file.id)) {
          continue
        }
        if (unifiedEditorFileIds.has(file.id)) {
          emittedEditorFileIds.add(file.id)
          continue
        }
        const fallbackTab = buildMobileMarkdownTab(inputs, file) ?? buildMobileFileTab(inputs, file)
        tabs.push(fallbackTab)
        fallbackEditorTabs.push({ tabId: fallbackTab.id, groupId: null })
        emittedEditorFileIds.add(file.id)
      }
    }

    const active = tabs.find((tab) => tab.isActive) ?? null
    const tabGroups = appendFallbackEditorTabsToGroups(
      groupProjection.tabGroups,
      inputs.groups,
      inputs.activeGroupId,
      fallbackEditorTabs,
      active?.id ?? null
    )
    const tabGroupLayout =
      tabGroups && tabGroups.length > 0
        ? pruneTabGroupLayout(inputs.tabGroupLayout, new Set(tabGroups.map((group) => group.id)))
        : groupProjection.tabGroupLayout
    const content = {
      activeGroupId: inputs.activeGroupId,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      ...(tabGroups && tabGroups.length > 0 ? { tabGroups } : {}),
      ...(tabGroupLayout ? { tabGroupLayout } : {}),
      tabs
    }
    const candidateVersion = ++graphState.mobileSessionSnapshotVersion
    if (cached && jsonContentEquals(cached.content, content)) {
      const snapshot =
        cached.snapshot.worktreeInstanceId === inputs.worktreeInstanceId
          ? cached.snapshot
          : {
              worktree: worktreeId,
              ...(inputs.worktreeInstanceId
                ? { worktreeInstanceId: inputs.worktreeInstanceId }
                : {}),
              publicationEpoch: mobilePublicationEpoch,
              snapshotVersion: candidateVersion,
              ...content
            }
      graphState.mobileSessionSnapshotCacheByWorktree.set(worktreeId, {
        inputs,
        content,
        snapshot
      })
      snapshots.push(snapshot)
      continue
    }
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: worktreeId,
      ...(inputs.worktreeInstanceId ? { worktreeInstanceId: inputs.worktreeInstanceId } : {}),
      publicationEpoch: mobilePublicationEpoch,
      snapshotVersion: candidateVersion,
      ...content
    }
    graphState.mobileSessionSnapshotCacheByWorktree.set(worktreeId, { inputs, content, snapshot })
    snapshots.push(snapshot)
  }
  for (const worktreeId of graphState.mobileSessionSnapshotCacheByWorktree.keys()) {
    if (!worktreeIds.has(worktreeId)) {
      graphState.mobileSessionSnapshotCacheByWorktree.delete(worktreeId)
    }
  }
  return snapshots
}
