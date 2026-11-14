import type { DashboardCardDotState, DashboardCardTerminalInput } from './dashboard-snapshot'

export const FLOATING_WORKSPACE_WINDOW_SURFACE = 'floating-workspace'

export const FLOATING_WORKSPACE_WINDOW_CHANNELS = {
  show: 'floatingWorkspaceWindow:show',
  hide: 'floatingWorkspaceWindow:hide',
  destroy: 'floatingWorkspaceWindow:destroy',
  publishSnapshot: 'floatingWorkspaceWindow:publishSnapshot',
  snapshot: 'floatingWorkspaceWindow:snapshot',
  requestSnapshot: 'floatingWorkspaceWindow:requestSnapshot',
  snapshotRequested: 'floatingWorkspaceWindow:snapshotRequested',
  requestDock: 'floatingWorkspaceWindow:requestDock',
  dockRequested: 'floatingWorkspaceWindow:dockRequested',
  ackAgent: 'floatingWorkspaceWindow:ackAgent',
  agentAcked: 'floatingWorkspaceWindow:agentAcked',
  hiddenByUser: 'floatingWorkspaceWindow:hiddenByUser'
} as const

export type FloatingWorkspaceWindowActiveTab = {
  tabId: string
  title: string
  kind: 'terminal' | 'other'
  status: DashboardCardDotState
  paneKey: string
  /** Non-null only while the pane's PTY is live. */
  ptyId: string | null
  terminalInput?: DashboardCardTerminalInput
}

export type FloatingWorkspaceWindowSnapshot = {
  version: 1
  activeTab: FloatingWorkspaceWindowActiveTab | null
}
