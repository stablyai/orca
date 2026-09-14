import type { Mock } from 'vitest'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../shared/tui-agent'

// Why: the terminal-create scenario returns spies whose inferred types can't be named
// across module boundaries, so the harness annotates itself with the shapes below.

export type ListenerRef<TListener> = { current: TListener | null }

type SpyMock = Mock<(...args: unknown[]) => void>

export type TerminalCreateListenerPayload = {
  requestId?: string
  worktreeId: string
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  viewMode?: 'terminal' | 'chat'
  title?: string
  ptyId?: string
  activate?: boolean
  focus?: boolean
  presentation?: 'background' | 'focused'
  tabId?: string
  leafId?: string
  splitFromLeafId?: string
  splitDirection?: 'horizontal' | 'vertical'
  splitTelemetrySource?: 'contextual_tour' | 'keyboard' | 'context_menu' | 'command' | 'unknown'
}

export type RequestTerminalCreateListenerPayload = {
  requestId: string
  worktreeId?: string
  afterTabId?: string
  targetGroupId?: string
  command?: string
  cwd?: string
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  viewMode?: 'terminal' | 'chat'
  title?: string
  activate?: boolean
  presentation?: 'background' | 'focused'
  source?: 'runtime-session'
}

export type FocusTerminalListenerPayload = {
  tabId: string
  worktreeId: string
  leafId?: string | null
  ackPaneKeyOnSuccess?: string
  flashFocusedPane?: boolean
  scrollToBottomIfOutputSinceLastView?: boolean
}

/** Store surface useIpcEvents reads while surfacing a terminal create. */
export type TerminalCreateSurfacingStore = {
  setUpdateStatus: SpyMock
  createTab: Mock<
    (
      worktreeId: string,
      groupId?: string,
      tabType?: string,
      options?: { id?: string }
    ) => { id: string }
  >
  setActiveView: SpyMock
  setActiveWorktree: SpyMock
  markWorktreeVisited: SpyMock
  recordWorktreeVisit: SpyMock
  isNavigatingHistory: boolean
  setActiveTabType: SpyMock
  setActiveTab: SpyMock
  revealWorktreeInSidebar: SpyMock
  setTabCustomTitle: SpyMock
  queueTabStartupCommand: SpyMock
  registerAgentLaunchConfig: SpyMock
  clearAgentLaunchConfig: SpyMock
  updateTabPtyId: Mock<(tabId: string, ptyId: string) => void>
  setTabLayout: Mock<(tabId: string, layout: unknown) => void>
  tabsByWorktree: Record<string, { id: string; ptyId?: string | null; title?: string }[]>
  folderWorkspaces: unknown[]
  projectGroups: unknown[]
  repos: { id: string; connectionId: string | null; executionHostId: string }[]
  worktreesByRepo: Record<string, { id: string; repoId: string }[]>
  openFiles: unknown[]
  browserTabsByWorktree: Record<string, unknown>
  tabBarOrderByWorktree: Record<string, unknown>
  setTabBarOrder: SpyMock
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId: Record<string, unknown>
  fetchRepos: SpyMock
  fetchWorktrees: SpyMock
  activeModal: unknown
  closeModal: SpyMock
  openModal: SpyMock
  activeWorktreeId: string
  activeView: string
  setActiveRepo: SpyMock
  setIsFullScreen: SpyMock
  updateBrowserPageState: SpyMock
  activeTabType: string
  editorFontZoomLevel: number
  setEditorFontZoomLevel: SpyMock
  setRateLimitsFromPush: SpyMock
  setSshConnectionState: SpyMock
  setSshTargetLabels: SpyMock
  setPortForwards: SpyMock
  clearPortForwards: SpyMock
  setDetectedPorts: SpyMock
  enqueueSshCredentialRequest: SpyMock
  removeSshCredentialRequest: SpyMock
  clearTabPtyId: SpyMock
  settings: {
    terminalFontSize: number
    experimentalNativeChat: boolean
    openAgentTabsInChatByDefault: boolean
    activeRuntimeEnvironmentId: string | undefined
  }
}

export type TerminalCreateSurfacingScenario = Pick<
  TerminalCreateSurfacingStore,
  | 'createTab'
  | 'setActiveView'
  | 'setActiveWorktree'
  | 'markWorktreeVisited'
  | 'recordWorktreeVisit'
  | 'setActiveTabType'
  | 'setActiveTab'
  | 'revealWorktreeInSidebar'
  | 'setTabCustomTitle'
  | 'queueTabStartupCommand'
  | 'registerAgentLaunchConfig'
  | 'updateTabPtyId'
  | 'setTabLayout'
> & {
  replyTerminalCreate: SpyMock
  dispatchEvent: SpyMock
  createFloatingWorkspaceTerminalTab: SpyMock
  createWebRuntimeSessionTerminal: Mock<
    (...args: unknown[]) => Promise<{ status: string; message: string }>
  >
  focusRuntimeTerminalSurface: Mock<() => boolean>
  focusTerminalTabSurface: SpyMock
  storeState: TerminalCreateSurfacingStore
  createTerminalListenerRef: ListenerRef<(data: TerminalCreateListenerPayload) => void>
  requestTerminalCreateListenerRef: ListenerRef<
    (data: RequestTerminalCreateListenerPayload) => void
  >
  focusTerminalListenerRef: ListenerRef<(data: FocusTerminalListenerPayload) => void>
  newTerminalTabListenerRef: ListenerRef<() => void>
}
