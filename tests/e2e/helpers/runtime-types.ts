import type { AppState } from '../../../src/renderer/src/store/types'
import type { OpenFile, RightSidebarTab } from '../../../src/renderer/src/store/slices/editor'
import type { ManagedPane } from '../../../src/renderer/src/lib/pane-manager/pane-manager-types'
import type {
  BrowserWorkspace,
  Repo,
  TerminalTab,
  Worktree,
  WorkspaceVisibleTabType
} from '../../../src/shared/types'

export type AppStore = {
  getState(): AppState
}

export type PaneManagerLike = {
  getActivePane?(): ManagedPane | null
  getPanes?(): ManagedPane[]
}

export type ExplorerFileSummary = Pick<OpenFile, 'id' | 'filePath' | 'relativePath'>
export type BrowserTabSummary = Pick<BrowserWorkspace, 'id' | 'url' | 'title'>
export type TerminalTabSummary = Pick<TerminalTab, 'id' | 'title' | 'customTitle'>
export type SidebarStateSummary = {
  rightSidebarOpen: boolean
  rightSidebarTab: RightSidebarTab
}
export type TestRepoState = {
  repos: Repo[]
  worktreesByRepo: Record<string, Worktree[]>
}
export type TerminalViewState = {
  activeTabId: string | null
  activeTabType: WorkspaceVisibleTabType
  activeWorktreeId: string | null
  ptyIdsByTabId: Record<string, string[]>
  tabsByWorktree: Record<string, TerminalTab[]>
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __store?: AppStore
    __paneManagers?: Map<string, PaneManagerLike>
  }
}

export function getWindowStore(): AppStore | null {
  return window.__store ?? null
}

export function getAppState(): AppState {
  const store = getWindowStore()
  if (!store) {
    throw new Error('window.__store is not available — is the app in dev mode?')
  }

  return store.getState()
}
