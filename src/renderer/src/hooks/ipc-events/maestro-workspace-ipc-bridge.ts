import { flushPendingEditorChange } from '@/components/editor/editor-pending-flush'
import { detectLanguage } from '@/lib/language-detect'
import { openExactMaestroWorkspace } from '@/lib/maestro-workspace-navigation'
import { useAppStore } from '../../store'
import { hashMarkdownContent } from '../../../../shared/mobile-markdown-document'
import type {
  RuntimeMaestroWorkspaceTabCommand,
  RuntimeMaestroWorkspaceTabCommandResponse
} from '../../../../shared/runtime-types'
import { resolveBrowserSessionTabTarget } from './browser-session-tab-target'

export function openMaestroCanvasFromIpc(
  state: Parameters<typeof openExactMaestroWorkspace>[0],
  target: { executionHostId: string; workspaceKey: string }
): boolean {
  return openExactMaestroWorkspace(state, target)
}

export function focusExactMobileSessionTab(
  store: ReturnType<typeof useAppStore.getState>,
  worktreeId: string,
  tabId: string
): void {
  const tab = (store.unifiedTabsByWorktree[worktreeId] ?? []).find((item) => item.id === tabId)
  const browserTarget = resolveBrowserSessionTabTarget(store, worktreeId, tabId)
  if (!tab) {
    if (browserTarget) {
      store.setActiveWorktree(worktreeId)
      store.markWorktreeVisited(worktreeId)
      store.setActiveView('terminal')
      store.setActiveBrowserTab(browserTarget.workspaceId)
      store.setActiveTabType('browser')
      store.revealWorktreeInSidebar(worktreeId)
    }
    return
  }
  store.setActiveWorktree(worktreeId)
  store.markWorktreeVisited(worktreeId)
  store.setActiveView('terminal')
  if (browserTarget) {
    store.focusGroup(worktreeId, tab.groupId)
    store.activateTab(tab.id)
    store.setActiveBrowserTab(browserTarget.workspaceId)
    store.setActiveTabType('browser')
  } else {
    store.setActiveFile(tab.entityId)
    store.focusGroup(worktreeId, tab.groupId)
    store.activateTab(tab.id)
    store.setActiveTabType('editor')
  }
  store.revealWorktreeInSidebar(worktreeId)
}

export function executeMaestroWorkspaceTabCommand(
  store: ReturnType<typeof useAppStore.getState>,
  command: RuntimeMaestroWorkspaceTabCommand,
  readState: typeof useAppStore.getState = useAppStore.getState
): Omit<RuntimeMaestroWorkspaceTabCommandResponse, 'requestId'> {
  if (command.kind === 'focus') {
    focusExactMobileSessionTab(store, command.worktreeId, command.tabId)
    const current = readState()
    const tab = (current.unifiedTabsByWorktree[command.worktreeId] ?? []).find(
      (candidate) => candidate.id === command.tabId
    )
    const selectedBrowserWorkspaceId =
      tab?.contentType === 'browser'
        ? current.activeBrowserTabIdByWorktree[command.worktreeId]
        : undefined
    const exactTabIsActive = current.groupsByWorktree[command.worktreeId]?.some(
      (group) => group.id === tab?.groupId && group.activeTabId === command.tabId
    )
    const exactSurfaceIsActive =
      tab?.contentType === 'browser'
        ? current.activeTabTypeByWorktree[command.worktreeId] === 'browser' &&
          selectedBrowserWorkspaceId === tab.entityId
        : current.activeTabTypeByWorktree[command.worktreeId] === 'editor' &&
          current.activeFileId === tab?.entityId
    if (!tab || !exactTabIsActive || !exactSurfaceIsActive) {
      throw new Error('Exact workspace tab did not become active.')
    }
    return { ok: true, tabId: tab.id }
  }
  if (command.kind === 'read-content') {
    const tab = (store.unifiedTabsByWorktree[command.worktreeId] ?? []).find(
      (candidate) => candidate.id === command.tabId
    )
    if (!tab || tab.contentType !== 'editor') {
      throw new Error('Exact editor tab was not found.')
    }
    const file = store.openFiles.find(
      (candidate) => candidate.worktreeId === command.worktreeId && candidate.id === tab.entityId
    )
    if (!file) {
      throw new Error('Exact editor model was not found.')
    }
    flushPendingEditorChange(file.id)
    const content = useAppStore.getState().editorDrafts[file.id]
    if (content === undefined) {
      throw new Error('Exact dirty editor model was not available.')
    }
    return { ok: true, tabId: tab.id, content, modelRevision: hashMarkdownContent(content) }
  }
  if (command.kind === 'rename') {
    const tab = (store.unifiedTabsByWorktree[command.worktreeId] ?? []).find(
      (candidate) => candidate.id === command.tabId
    )
    if (!tab) {
      throw new Error('Exact workspace tab was not found.')
    }
    if (tab.contentType === 'terminal') {
      store.setTabCustomTitle(tab.entityId, command.title)
    } else {
      store.setTabCustomLabel(tab.id, command.title)
    }
    return { ok: true, tabId: tab.id }
  }
  const targetGroupId = store.activeGroupIdByWorktree[command.worktreeId]
  if (!targetGroupId) {
    throw new Error('Annotation target group was not found.')
  }
  const activeGroup = store.groupsByWorktree[command.worktreeId]?.find(
    (group) => group.id === targetGroupId
  )
  const selectedMaestroTab = (store.unifiedTabsByWorktree[command.worktreeId] ?? []).find(
    (tab) => tab.id === activeGroup?.activeTabId && tab.systemRole === 'workspace-maestro'
  )
  const basename = command.relativePath.split(/[\\/]/).pop() || command.relativePath
  const fileId = store.openFile(
    {
      filePath: command.filePath,
      relativePath: command.relativePath,
      worktreeId: command.worktreeId,
      language: detectLanguage(basename),
      mode: 'edit'
    },
    { preview: false, targetGroupId }
  )
  const latest = useAppStore.getState()
  const tab = latest.findTabForEntityInGroup(command.worktreeId, targetGroupId, fileId, 'editor')
  if (
    selectedMaestroTab &&
    latest.unifiedTabsByWorktree[command.worktreeId]?.some(
      (candidate) =>
        candidate.id === selectedMaestroTab.id && candidate.systemRole === 'workspace-maestro'
    )
  ) {
    latest.activateTab(selectedMaestroTab.id, { worktreeId: command.worktreeId })
  }
  if (!tab || tab.groupId !== targetGroupId) {
    throw new Error('Annotation tab identity was not acknowledged.')
  }
  return { ok: true, tabId: tab.id }
}

export function registerMaestroWorkspaceIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onOpenMaestroCanvas?.(({ executionHostId, workspaceKey }) =>
      openMaestroCanvasFromIpc(useAppStore.getState(), { executionHostId, workspaceKey })
    ) ?? (() => {})
  )
  unsubs.push(
    window.api.ui.onMaestroWorkspaceTabCommand?.((command) => {
      try {
        window.api.ui.respondMaestroWorkspaceTabCommand({
          requestId: command.requestId,
          ...executeMaestroWorkspaceTabCommand(useAppStore.getState(), command)
        })
      } catch (error) {
        window.api.ui.respondMaestroWorkspaceTabCommand({
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : 'Workspace tab command failed.'
        })
      }
    }) ?? (() => {})
  )
}
