import type { AgentStatusOrchestrationContext } from './agent-status-types'
import type { RemoteServerUpdateSupport } from './remote-server-update'
import type { RemoteRuntimeSharedConnectionDiagnostics } from './remote-runtime-shared-control-types'
import type { RuntimeHostConnectionState } from './runtime-host-connection-state'
import type { RuntimeCapability } from './protocol-version'
import type {
  RuntimeBrowserUnavailableReason,
  RuntimeDegradation
} from './runtime-capability-degradation'
import type { TabGroupLayoutNode } from './tab-types'
import type { TerminalPaneLayoutNode } from './terminal-tab-types'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTerminalClientTab
} from './runtime-mobile-session-tab-contracts'

export type * from './runtime-mobile-session-tab-contracts'

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
  /** Optional policy for clients that negotiated worktree.create-idempotency.v1. */
  worktreeCreateIdempotency?: {
    dedupeTtlMs: number
  }
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
    /** Canonical runtime transport verdict, when the caller has runtime evidence. */
    connectionState?: RuntimeHostConnectionState
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
  /** Immutable catalog identity used to fence snapshots across path reuse. */
  worktreeInstanceId?: string
  publicationEpoch: string
  snapshotVersion: number
  activeGroupId: string | null
  activeTabId: string | null
  activeTabType: 'terminal' | 'markdown' | 'file' | 'browser' | 'agent-session' | null
  tabGroups?: RuntimeMobileSessionTabGroup[]
  tabGroupLayout?: TabGroupLayoutNode | null
  retiredTerminalSurfaces?: RuntimeMobileSessionRetiredTerminalSurface[]
  tabs: RuntimeMobileSessionSnapshotTab[]
}

export type RuntimeMobileSessionRetiredTerminalSurface = {
  parentTabId: string
  leafId: string
  ptyId: string
  terminal: string
  incarnationId?: string
}

export type RuntimeMobileSessionTabsResult = {
  worktree: string
  publicationEpoch: string
  snapshotVersion: number
  navigationIntent?: 'follow'
  activeGroupId: string | null
  activeTabId: string | null
  activeTabType: 'terminal' | 'markdown' | 'file' | 'browser' | 'agent-session' | null
  tabGroups?: RuntimeMobileSessionTabGroup[]
  tabGroupLayout?: TabGroupLayoutNode | null
  retiredTerminalSurfaces?: RuntimeMobileSessionRetiredTerminalSurface[]
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
