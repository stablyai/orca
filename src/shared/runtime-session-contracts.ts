import type { AgentStatusEntry, AgentStatusOrchestrationContext } from './agent-status-types'
import type { BrowserCertificateFailure, BrowserLoadError } from './browser-workspace-types'
import type { RemoteServerUpdateSupport } from './remote-server-update'
import type { RemoteRuntimeSharedConnectionDiagnostics } from './remote-runtime-shared-control-types'
import type { RuntimeBrowserPlacement } from './runtime-browser-placement'
import type { RuntimeCapability } from './protocol-version'
import type {
  RuntimeBrowserUnavailableReason,
  RuntimeDegradation
} from './runtime-capability-degradation'
import type { TabGroupLayoutNode } from './tab-types'
import type { TerminalColorOverrides } from './terminal-color-overrides'
import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from './terminal-tab-types'
import type { TuiAgent } from './tui-agent'

export type RuntimeGraphStatus = 'ready' | 'reloading' | 'unavailable'

export type RuntimeDesktopWindowStatus = 'available' | 'openable' | 'initializing' | 'blocked'

export const HEADLESS_RUNTIME_WINDOW_ID = 0

export type DeviceScope = 'mobile' | 'runtime'

export type RuntimeTerminalDriverState =
  | { kind: 'idle' }
  | { kind: 'desktop' }
  | { kind: 'mobile'; clientId: string }

export type RuntimeBrowserDriverState = RuntimeTerminalDriverState

export const BROWSER_UNAVAILABLE_ERROR_CODE = 'browser_unavailable' as const

// Why: one sentence per cause, each naming the thing the operator can change. The host
// renders these so an older client still shows an accurate reason it cannot decode.
const BROWSER_UNAVAILABLE_MESSAGES: Record<RuntimeBrowserUnavailableReason, string> = {
  unconfigured:
    'Browser automation has no backend on this host. Install the Orca desktop app, or set ORCA_BROWSER_EXECUTABLE to a Chromium executable.',
  driver_missing:
    'ORCA_BROWSER_EXECUTABLE is set, but the bundled agent-browser driver is missing or not executable on this host, so Chromium cannot be driven.',
  executable_not_found: 'ORCA_BROWSER_EXECUTABLE points at a path that does not exist.',
  executable_not_executable:
    'ORCA_BROWSER_EXECUTABLE points at a file that is not executable by this host.',
  electron_start_failed: 'The installed Electron browser provider failed to start.',
  chromium_start_failed:
    'The Chromium browser provider named by ORCA_BROWSER_EXECUTABLE failed to start.',
  provider_unhealthy: 'The browser provider started but is no longer answering health checks.',
  desktop_window_unavailable:
    'Browser automation on this host needs a desktop window, and none is available.',
  unknown: 'Browser automation is unavailable on this host, and the cause could not be determined.'
}

export function browserUnavailableMessage(
  reason: RuntimeBrowserUnavailableReason,
  detail?: string
): string {
  const base = BROWSER_UNAVAILABLE_MESSAGES[reason]
  return detail ? `${base} (${detail})` : base
}

export type RuntimeStatus = {
  runtimeId: string
  /** Authenticated requester identity. Missing for in-process callers and older hosts. */
  pairedDeviceId?: string
  rendererGraphEpoch: number
  graphStatus: RuntimeGraphStatus
  authoritativeWindowId: number | null
  desktopWindowStatus?: RuntimeDesktopWindowStatus
  liveTabCount: number
  liveLeafCount: number
  runtimeProtocolVersion?: number
  minCompatibleRuntimeClientVersion?: number
  capabilities?: RuntimeCapability[]
  /**
   * Optional for mixed-version peers. Absence means the host predates structured
   * degradation reporting, not that the host proved every optional feature available.
   */
  degradations?: RuntimeDegradation[]
  appVersion?: string
  remoteUpdateSupport?: RemoteServerUpdateSupport
  remoteControl?: RemoteRuntimeSharedConnectionDiagnostics | null
  hostPlatform?: NodeJS.Platform
  terminalWindowsShell?: string | null
  deviceScope?: DeviceScope
  floatingWorkspaceEnabled?: boolean
  // COMPAT(runtimeStatusMobileAliases): added 2026-05-15 for older mobile builds.
  protocolVersion?: number
  minCompatibleMobileVersion?: number
}

export type CliRuntimeState =
  | 'not_running'
  | 'starting'
  | 'ready'
  | 'graph_not_ready'
  | 'stale_bootstrap'

export type CliStatusResult = {
  target?: { kind: 'local' } | { kind: 'environment'; environment: string }
  app: {
    running: boolean
    pid: number | null
    desktopWindowStatus?: RuntimeDesktopWindowStatus
  }
  runtime: {
    state: CliRuntimeState
    reachable: boolean
    runtimeId: string | null
    appVersion?: string
    remoteUpdateSupport?: RemoteServerUpdateSupport
    capabilities?: RuntimeCapability[]
    degradations?: RuntimeDegradation[]
  }
  graph: {
    state: RuntimeGraphStatus | 'not_running' | 'starting'
  }
}

export type RuntimeSyncedTab = {
  tabId: string
  worktreeId: string
  title: string | null
  activeLeafId: string | null
  layout: TerminalPaneLayoutNode | null
}

export type RuntimeSyncedLeaf = {
  tabId: string
  worktreeId: string
  leafId: string
  paneRuntimeId: number
  ptyId: string | null
  paneTitle?: string | null
  title?: string | null
}

export type RuntimeSyncWindowGraph = {
  tabs: RuntimeSyncedTab[]
  leaves: RuntimeSyncedLeaf[]
  mobileSessionTabs?: RuntimeMobileSessionTabsSnapshot[]
  unchangedMobileSessionWorktrees?: string[]
}

export type RuntimeRendererSyncWindowGraph = RuntimeSyncWindowGraph & {
  rendererGeneration: string
}

export type RuntimeNativeChatLaunchDraftResolution = {
  tabId: string
  text: string
  createdAt: number
}

export type RuntimeSyncWindowGraphResult = RuntimeStatus & {
  agentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  nativeChatLaunchDraftResolutions?: RuntimeNativeChatLaunchDraftResolution[]
  mobileSessionResyncWorktrees?: string[]
}

export type RuntimeMobileSessionTerminalTab = {
  type: 'terminal'
  id: string
  title: string
  quickCommandLabel?: string | null
  parentTabId: string
  leafId: string
  ptyId?: string | null
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

export type RuntimeMobileSessionSnapshotTab =
  | RuntimeMobileSessionTerminalTab
  | RuntimeMobileSessionMarkdownTab
  | RuntimeMobileSessionFileTab
  | RuntimeMobileSessionBrowserTab

export type RuntimeMobileSessionTerminalClientTab =
  | (RuntimeMobileSessionTerminalTab & { status: 'pending-handle'; terminal: null })
  | (RuntimeMobileSessionTerminalTab & { status: 'ready'; terminal: string })

export type RuntimeMobileSessionClientTab =
  | RuntimeMobileSessionTerminalClientTab
  | RuntimeMobileSessionMarkdownTab
  | RuntimeMobileSessionFileTab
  | RuntimeMobileSessionBrowserTab

export type RuntimeMobileSessionTabGroup = {
  id: string
  activeTabId: string | null
  tabOrder: string[]
  recentTabIds?: string[]
}

type RuntimeMobileSessionTabMoveBase = {
  tabId: string
  targetGroupId: string
}

export type RuntimeMobileSessionTabMove =
  | (RuntimeMobileSessionTabMoveBase & { kind: 'reorder'; tabOrder: string[] })
  | (RuntimeMobileSessionTabMoveBase & { kind: 'move-to-group'; index?: number })
  | (RuntimeMobileSessionTabMoveBase & {
      kind: 'split'
      splitDirection: 'left' | 'right' | 'up' | 'down'
    })

export type RuntimeMobileSessionTabMoveResult = { moved: true }

export type RuntimeMobileSessionTabCloseResult = {
  closed: true
  refused?: true
  refusalReason?:
    | 'missing-intent'
    | 'stale-publication'
    | 'stale-terminal'
    | 'live-host-pty'
    | 'unknown-liveness'
    | 'retirement-owner'
  snapshotRepublished?: true
}

export type RuntimeSessionTabCloseReason = 'user' | 'pty-exit' | 'cleanup'

/**
 * The publication epoch a runtime answers with for a worktree it has published nothing for yet —
 * the state every worktree is in for a moment after the host process restarts.
 *
 * Paired with `snapshotVersion: 0` it marks a synthesized placeholder, not a host answer: the
 * runtime is saying "ask me later", not "those tabs are gone". Clients must not read absence from
 * such a frame as evidence a tab was closed.
 */
export const UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH = 'none'

export type RuntimeMobileSessionTabsSnapshot = {
  worktree: string
  publicationEpoch: string
  snapshotVersion: number
  activeGroupId: string | null
  activeTabId: string | null
  activeTabType: 'terminal' | 'markdown' | 'file' | 'browser' | null
  tabGroups?: RuntimeMobileSessionTabGroup[]
  tabGroupLayout?: TabGroupLayoutNode | null
  tabs: RuntimeMobileSessionSnapshotTab[]
}

export type RuntimeMobileSessionTabsResult = {
  worktree: string
  publicationEpoch: string
  snapshotVersion: number
  navigationIntent?: 'follow'
  activeGroupId: string | null
  activeTabId: string | null
  activeTabType: 'terminal' | 'markdown' | 'file' | 'browser' | null
  tabGroups?: RuntimeMobileSessionTabGroup[]
  tabGroupLayout?: TabGroupLayoutNode | null
  tabs: RuntimeMobileSessionClientTab[]
  /**
   * Set while a freshly started runtime has not yet taken back the client-hosted pages its paired
   * hosts are still holding. Such a snapshot is authoritative about terminals, which it rehydrated
   * from disk, but silently empty of browser rows it has simply not heard about yet — so a client
   * must not read the absence of its own client-hosted rows here as "the host closed them".
   *
   * Always bounded: the runtime clears it once a host attaches, and drops it on a deadline so a
   * host that never returns cannot hold rows open forever.
   */
  clientHostedPagesUnreconciled?: true
}

export type RuntimeMobileSessionCreateTerminalResult = {
  tab: RuntimeMobileSessionTerminalClientTab
  publicationEpoch: string
  snapshotVersion: number
}

export type RuntimeMobileSessionTabsRemovedResult = RuntimeMobileSessionTabsResult & {
  removed: true
  activeGroupId: null
  activeTabId: null
  activeTabType: null
  tabs: []
}
