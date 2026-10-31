import type { AgentStatusEntry } from './agent-status-types'
import type { BrowserCertificateFailure, BrowserLoadError } from './browser-workspace-types'
import type { RuntimeBrowserPlacement } from './runtime-browser-placement'
import type { TerminalColorOverrides } from './terminal-color-overrides'
import type { TerminalLayoutSnapshot, TerminalTab } from './terminal-tab-types'
import type { TuiAgent } from './tui-agent'
import type { StructuredAgentId } from './agent-session-provider-handle'

export type RuntimeMobileSessionTerminalTab = {
  type: 'terminal'
  id: string
  title: string
  /** Host manual title; absent on old hosts preserves the client record, whereas null clears it. */
  customTitle?: string | null
  quickCommandLabel?: string | null
  /** Window-to-main names ranked above live titles; generatedTitle is sent only when enabled. */
  aiVaultTitle?: TerminalTab['aiVaultTitle']
  generatedTitle?: string | null
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
  /** Optional desktop contrast override (#10754); absent uses the client’s background-luminance floor. */
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
  /** Set by a desktop for a "New Markdown" document not yet named; hosts and phones before it omit it. */
  isUntitled?: true
  documentVersion: string
  color?: string | null
  isPinned?: boolean
  /** The paired server the file lives on. Its publisher sets it; runtimes strip it before serving. */
  hostRuntimeEnvironmentId?: string
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
  oldPath?: string
  isDirty: boolean
  color?: string | null
  isPinned?: boolean
  isActive: boolean
  /** The paired server the file lives on. Its publisher sets it; runtimes strip it before serving. */
  hostRuntimeEnvironmentId?: string
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
  /** The paired server the page runs on. Its publisher sets it; runtimes strip it before serving. */
  hostRuntimeEnvironmentId?: string
}

export type RuntimeMobileSessionAgentTab = {
  type: 'agent-session'
  id: string
  title: string
  sessionId: string
  replacesSessionId?: string
  /** Host-registered agent; gate names beyond Claude/Codex on client registered-agents capability. */
  agent: StructuredAgentId
  /** The host's structured status row for this chat. Optional: old hosts never send it. */
  chatStatus?: RuntimeMobileSessionAgentTabStatus
  color?: string | null
  isPinned?: boolean
  isActive: boolean
}

export type RuntimeMobileSessionAgentTabStatus = Pick<
  AgentStatusEntry,
  | 'state'
  | 'workingMode'
  | 'interrupted'
  | 'mainAgent'
  | 'updatedAt'
  | 'evidenceObservedAt'
  | 'structuredHostOwned'
>

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
