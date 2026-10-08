import type { AgentStatusEntry } from './agent-status-types'
import type { BrowserCertificateFailure, BrowserLoadError } from './browser-workspace-types'
import type { RuntimeBrowserPlacement } from './runtime-browser-placement'
import type { TerminalColorOverrides } from './terminal-color-overrides'
import type { TerminalLayoutSnapshot } from './terminal-tab-types'
import type { TuiAgent } from './tui-agent'
import type { StructuredAgentId } from './agent-session-provider-handle'

export const SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY = 'session-tabs.close-intent.v1' as const
export const SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY =
  'session-tabs.authoritative-inventory.v1' as const
// This proves headed and runtime-owned host paths place after a complete split parent.
export const SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY =
  'session-tabs.split-group-placement.v1' as const
// Clients retain each retirement proof until the surface is published live again.
export const SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY =
  'session-tabs.retirement-proof-delta.v1' as const
// The host accepts mobile session-tab view-mode writes and republishes the adopted mode.
export const SESSION_TABS_MOBILE_VIEW_MODE_RUNTIME_CAPABILITY =
  'session-tabs.mobile-view-mode.v1' as const

export const SESSION_TABS_RUNTIME_CAPABILITIES = [
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY,
  SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY,
  SESSION_TABS_MOBILE_VIEW_MODE_RUNTIME_CAPABILITY
] as const

export type RuntimeMobileSessionTerminalTab = {
  type: 'terminal'
  id: string
  title: string
  quickCommandLabel?: string | null
  parentTabId: string
  leafId: string
  ptyId?: string | null
  /** Host-owned PTY incarnation used to fence remote identity observations. */
  incarnationId?: string | null
  terminalTheme?: RuntimeMobileTerminalTheme
  agentStatus?: AgentStatusEntry | null
  /** Event-only lead-turn end time for paired clients; never persisted in AgentStatusEntry. */
  turnCompletedAt?: number
  launchAgent?: TuiAgent
  startupCwd?: string
  parentLayout?: TerminalLayoutSnapshot
  color?: string | null
  isPinned?: boolean
  viewMode?: 'terminal' | 'chat'
  launchDraft?: string
  launchDraftCreatedAt?: number
  isActive: boolean
}

export type RuntimeMobileTerminalTheme = {
  mode: 'dark' | 'light'
  theme: TerminalColorOverrides
  /** Optional desktop terminalMinimumContrastRatio override (#10754). Absent means the client picks
   *  its own background-luminance floor, which is what pre-#10754 clients always do. */
  minimumContrastRatio?: number
}

export type RuntimeMobileSessionMarkdownTab = {
  type: 'markdown'
  id: string
  title: string
  filePath: string
  relativePath: string
  language: 'markdown'
  mode: 'edit' | 'markdown-preview'
  isDirty: boolean
  isActive: boolean
  sourceFileId: string
  sourceFilePath: string
  sourceRelativePath: string
  documentVersion: string
  color?: string | null
  isPinned?: boolean
}

export type RuntimeMobileSessionFileTab = {
  type: 'file'
  id: string
  title: string
  filePath: string
  relativePath: string
  language: string
  mode?: 'edit' | 'diff'
  diffSource?: 'staged' | 'unstaged'
  isDirty: boolean
  color?: string | null
  isPinned?: boolean
  isActive: boolean
}

export type RuntimeMobileSessionBrowserTab = {
  type: 'browser'
  id: string
  title: string
  browserWorkspaceId: string
  browserPageId: string | null
  browserProfileId?: string
  executionHostKey?: string
  placement?: RuntimeBrowserPlacement
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  loadError?: BrowserLoadError | null
  certificateFailure?: BrowserCertificateFailure | null
  color?: string | null
  isPinned?: boolean
  isActive: boolean
}

export type RuntimeMobileSessionAgentTab = {
  type: 'agent-session'
  id: string
  title: string
  sessionId: string
  replacesSessionId?: string
  /** An agent the host registered. Beyond Claude and Codex, published only to clients advertising
   *  the registered-agents capability. */
  agent: StructuredAgentId
  color?: string | null
  isPinned?: boolean
  isActive: boolean
}

export type RuntimeMobileSessionSnapshotTab =
  | RuntimeMobileSessionTerminalTab
  | RuntimeMobileSessionMarkdownTab
  | RuntimeMobileSessionFileTab
  | RuntimeMobileSessionBrowserTab
  | RuntimeMobileSessionAgentTab

export type RuntimeMobileSessionTerminalClientTab =
  | (RuntimeMobileSessionTerminalTab & { status: 'pending-handle'; terminal: null })
  | (RuntimeMobileSessionTerminalTab & { status: 'ready'; terminal: string })

export type RuntimeMobileSessionClientTab =
  | RuntimeMobileSessionTerminalClientTab
  | RuntimeMobileSessionMarkdownTab
  | RuntimeMobileSessionFileTab
  | RuntimeMobileSessionBrowserTab
  | RuntimeMobileSessionAgentTab
