import { vi } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'

export type HarnessTab = { id: string; ptyId?: string | null; title?: string }

export type HarnessStoreState = {
  tabsByWorktree: Record<string, HarnessTab[]>
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId: Record<
    string,
    { root?: TerminalPaneLayoutNode; ptyIdsByLeafId?: Record<string, string> }
  >
  [key: string]: unknown
}

/** Store surface useIpcEvents touches at mount plus the terminal-reveal path. */
export function createHarnessStoreState(
  overrides: Partial<HarnessStoreState> & Pick<HarnessStoreState, 'tabsByWorktree'>
): HarnessStoreState {
  const state: HarnessStoreState = {
    createTab: vi.fn(() => ({ id: 'tab-minted' })),
    setActiveView: vi.fn(),
    setActiveWorktree: vi.fn(),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    isNavigatingHistory: false,
    setActiveTabType: vi.fn(),
    setActiveTab: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    setTabCustomTitle: vi.fn(),
    queueTabStartupCommand: vi.fn(),
    registerAgentLaunchConfig: vi.fn(),
    clearAgentLaunchConfig: vi.fn(),
    updateTabPtyId: vi.fn(),
    setTabLayout: vi.fn(),
    setTabBarOrder: vi.fn(),
    clearTabPtyId: vi.fn(),
    setUpdateStatus: vi.fn(),
    fetchRepos: vi.fn(),
    fetchWorktrees: vi.fn(),
    closeModal: vi.fn(),
    openModal: vi.fn(),
    setActiveRepo: vi.fn(),
    setIsFullScreen: vi.fn(),
    updateBrowserPageState: vi.fn(),
    setEditorFontZoomLevel: vi.fn(),
    setRateLimitsFromPush: vi.fn(),
    setSshConnectionState: vi.fn(),
    setSshTargetLabels: vi.fn(),
    setPortForwards: vi.fn(),
    clearPortForwards: vi.fn(),
    setDetectedPorts: vi.fn(),
    enqueueSshCredentialRequest: vi.fn(),
    removeSshCredentialRequest: vi.fn(),
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    folderWorkspaces: [],
    projectGroups: [],
    repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    openFiles: [],
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeModal: null,
    activeWorktreeId: 'wt-1',
    activeView: 'terminal',
    activeTabType: 'terminal',
    editorFontZoomLevel: 0,
    settings: {
      terminalFontSize: 13,
      experimentalNativeChat: false,
      openAgentTabsInChatByDefault: false,
      activeRuntimeEnvironmentId: undefined
    },
    ...overrides
  }
  if (overrides.setTabLayout === undefined) {
    state.setTabLayout = vi.fn(
      (tabId: string, layout: HarnessStoreState['terminalLayoutsByTabId'][string]) => {
        state.terminalLayoutsByTabId[tabId] = layout
      }
    )
  }
  return state
}
