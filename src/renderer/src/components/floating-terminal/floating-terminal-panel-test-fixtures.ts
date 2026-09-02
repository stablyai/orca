import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { KeybindingOverrides, TerminalShortcutPolicy } from '../../../../shared/keybindings'
import type { BrowserTab } from '../../../../shared/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { OpenFile } from '@/store/slices/editor'

export type FloatingPanelStoreState = {
  tabsByWorktree: Record<string, TerminalTab[]>
  browserTabsByWorktree: Record<string, BrowserTab[]>
  browserPagesByWorkspace: Record<string, unknown[]>
  groupsByWorktree: Record<string, TabGroup[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
  openFiles: OpenFile[]
  activeGroupIdByWorktree: Record<string, string | null>
  activeTabIdByWorktree: Record<string, string | null>
  expandedPaneByTabId: Record<string, boolean>
  renamingTabId: string | null
  createTab: (
    worktreeId: string,
    groupId?: string,
    shellOverride?: string,
    options?: { activate?: boolean; pendingActivationSpawn?: boolean; initialPtyId?: string }
  ) => TerminalTab
  createBrowserTab: (
    worktreeId: string,
    url: string,
    options?: {
      activate?: boolean
      focusAddressBar?: boolean
      sessionProfileId?: string | null
      sessionPartition?: string | null
      title?: string
      targetGroupId?: string
    }
  ) => BrowserTab
  closeTab: (tabId: string) => void
  closeBrowserTab: (tabId: string) => void
  closeFile: (fileId: string) => void
  closeUnifiedTab: (tabId: string) => Tab | null
  markFileDirty: (fileId: string, dirty: boolean) => void
  activateTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  setTabCustomTitle: (tabId: string, title: string | null) => void
  setRenamingTabId: (tabId: string | null) => void
  setTabColor: (tabId: string, color: string | null) => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  makePreviewFilePermanent: (fileId: string, tabId?: string) => void
  pinFile: (fileId: string, tabId?: string) => void
  openFile: (file: unknown, options?: unknown) => void
  browserDefaultUrl: string
  keybindings?: KeybindingOverrides
  tabBarOrderByWorktree: Record<string, string[]>
  settings: {
    activeRuntimeEnvironmentId?: string | null
    floatingTerminalCwd?: string
    terminalShortcutPolicy?: TerminalShortcutPolicy
  }
}

export const storeBox = {
  state: null as unknown
}

export function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: overrides.id ?? 'tab-1',
    ptyId: overrides.ptyId ?? null,
    worktreeId: overrides.worktreeId ?? FLOATING_TERMINAL_WORKTREE_ID,
    title: overrides.title ?? 'Terminal',
    customTitle: overrides.customTitle ?? null,
    color: overrides.color ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 0,
    ...overrides
  }
}

export function makeFile(overrides: Partial<OpenFile> = {}): OpenFile {
  const id = overrides.id ?? 'file-1'
  return {
    id,
    filePath: overrides.filePath ?? `/tmp/orca/${id}.md`,
    relativePath: overrides.relativePath ?? `${id}.md`,
    worktreeId: overrides.worktreeId ?? FLOATING_TERMINAL_WORKTREE_ID,
    language: overrides.language ?? 'markdown',
    isDirty: overrides.isDirty ?? false,
    mode: overrides.mode ?? 'edit',
    ...overrides
  }
}

// Models terminal-tab-actions.closeTerminalTab's store mutation: the real close removes the tab from
// the floating store *before* it fires onClosed, so the reclaim intent arms on a decremented count.
export function removeFloatingTerminalTabFromStore(entityId: string): void {
  const state = storeBox.state as FloatingPanelStoreState
  const current = state.tabsByWorktree?.[FLOATING_TERMINAL_WORKTREE_ID] ?? []
  const remaining = current.filter((tab) => tab.id !== entityId)
  if (remaining.length !== current.length) {
    setFloatingTabs(remaining)
  }
}

export function setFloatingTabs(tabs: TerminalTab[]): void {
  const state = storeBox.state as FloatingPanelStoreState
  const groupId = 'floating-group'
  const unifiedTabs = tabs.map<Tab>((tab, index) => ({
    id: tab.id,
    entityId: tab.id,
    groupId,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    contentType: 'terminal',
    label: tab.title,
    customLabel: tab.customTitle,
    color: tab.color,
    sortOrder: index,
    createdAt: tab.createdAt
  }))
  state.tabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: tabs }
  state.unifiedTabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: unifiedTabs }
  state.groupsByWorktree = {
    [FLOATING_TERMINAL_WORKTREE_ID]: [
      {
        id: groupId,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        activeTabId: unifiedTabs[0]?.id ?? null,
        tabOrder: unifiedTabs.map((tab) => tab.id),
        recentTabIds: unifiedTabs.map((tab) => tab.id)
      }
    ]
  }
  state.activeGroupIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: groupId }
  state.activeTabIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: tabs[0]?.id ?? null }
  state.tabBarOrderByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: tabs.map((tab) => tab.id) }
}

export function setFloatingEditorTabs(files: OpenFile[]): void {
  const state = storeBox.state as FloatingPanelStoreState
  const groupId = 'floating-group'
  const unifiedTabs = files.map<Tab>((file, index) => ({
    id: `tab-${file.id}`,
    entityId: file.id,
    groupId,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    contentType: 'editor',
    label: file.relativePath,
    customLabel: null,
    color: null,
    sortOrder: index,
    createdAt: index
  }))
  state.openFiles = files
  state.unifiedTabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: unifiedTabs }
  state.groupsByWorktree = {
    [FLOATING_TERMINAL_WORKTREE_ID]: [
      {
        id: groupId,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        activeTabId: unifiedTabs[0]?.id ?? null,
        tabOrder: unifiedTabs.map((tab) => tab.id),
        recentTabIds: unifiedTabs.map((tab) => tab.id)
      }
    ]
  }
  state.activeGroupIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: groupId }
}

export function setFloatingSimulatorTab(): Tab {
  const state = storeBox.state as FloatingPanelStoreState
  const groupId = 'floating-group'
  const tab: Tab = {
    id: 'simulator-tab',
    entityId: 'simulator-tab',
    groupId,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    contentType: 'simulator',
    label: 'Mobile Emulator',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  state.unifiedTabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: [tab] }
  state.groupsByWorktree = {
    [FLOATING_TERMINAL_WORKTREE_ID]: [
      {
        id: groupId,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        activeTabId: tab.id,
        tabOrder: [tab.id],
        recentTabIds: [tab.id]
      }
    ]
  }
  state.activeGroupIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: groupId }
  state.tabBarOrderByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: [tab.id] }
  return tab
}
