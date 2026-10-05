import type { AgentStatusEntry } from './agent-status-types'
import type { BrowserCertificateFailure, BrowserLoadError } from './browser-workspace-types'
import type { RuntimeBrowserPlacement } from './runtime-browser-placement'
import type { TerminalColorOverrides } from './terminal-color-overrides'
import type { TerminalConversationIdentity } from './terminal-conversation-identity'
import type { TerminalLayoutSnapshot } from './terminal-tab-types'
import type { TuiAgent } from './tui-agent'

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
  agent: 'claude' | 'codex'
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

/** Host-published only: the renderer snapshot input cannot carry these, so the projection is their sole producer. */
export type RuntimeMobileSessionTerminalConversationFields = {
  /** Absent when the host holds no conversation it publishes for this pane (or is an old host). */
  conversationIdentity?: TerminalConversationIdentity
  /** True-only: the tab has no status and the host offers its identity as agent evidence and address. */
  conversationOfferedWithoutStatus?: true
}

export type RuntimeMobileSessionTerminalClientTab =
  | (RuntimeMobileSessionTerminalTab &
      RuntimeMobileSessionTerminalConversationFields & {
        status: 'pending-handle'
        terminal: null
      })
  | (RuntimeMobileSessionTerminalTab &
      RuntimeMobileSessionTerminalConversationFields & { status: 'ready'; terminal: string })

export type RuntimeMobileSessionClientTab =
  | RuntimeMobileSessionTerminalClientTab
  | RuntimeMobileSessionMarkdownTab
  | RuntimeMobileSessionFileTab
  | RuntimeMobileSessionBrowserTab
  | RuntimeMobileSessionAgentTab
