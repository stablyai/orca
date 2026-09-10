import type { AgentStatusEntry } from './agent-status-types'
import type { BrowserCertificateFailure, BrowserLoadError } from './browser-workspace-types'
import type { RuntimeBrowserPlacement } from './runtime-browser-placement'
import type { TerminalColorOverrides } from './terminal-color-overrides'
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
  /** What to render: the user's name for this chat, else this agent's placeholder. */
  title: string
  /**
   * The user's name for this chat, separate from the resolved `title` so a client can tell an
   * unnamed chat from a named one. Three states, and absent must never read as "no name":
   * - present string — the host owns chat names and this is the one the user gave.
   * - present `null` — the host owns chat names and this chat has none.
   * - absent — the host predates host-owned chat names; the client keeps its own local name.
   */
  customTitle?: string | null
  sessionId: string
  replacesSessionId?: string
  agent: 'claude' | 'codex'
  color?: string | null
  isPinned?: boolean
  isActive: boolean
}

const STRUCTURED_AGENT_SESSION_HOST_TAB_PREFIX = 'agent-session:'

/** The id a structured chat is published under on the session-tab sync channel. */
export function structuredAgentSessionHostTabId(sessionId: string): string {
  return `${STRUCTURED_AGENT_SESSION_HOST_TAB_PREFIX}${sessionId}`
}

/** The session behind a host session-tab id, or null when the id names another tab kind. */
export function structuredAgentSessionIdFromHostTabId(hostTabId: string): string | null {
  return hostTabId.startsWith(STRUCTURED_AGENT_SESSION_HOST_TAB_PREFIX)
    ? hostTabId.slice(STRUCTURED_AGENT_SESSION_HOST_TAB_PREFIX.length)
    : null
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
