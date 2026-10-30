import type { MobileProjectSectionCatalog } from './mobile-project-sections-contract'
import type { AgentStatusOrchestrationContext } from './agent-status-types'
import type { RemoteServerUpdateSupport } from './remote-server-update'
import type { RemoteRuntimeSharedConnectionDiagnostics } from './remote-runtime/control/remote-runtime-shared-control-types'
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
import type { CliStatusCaller } from './orchestration-caller-status'
import type { RuntimeHostDescriptor } from './runtime-host-descriptor'
import type { TuiAgent } from './tui-agent'

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

// Render actionable per-cause messages host-side so older clients can display reasons they cannot decode.
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
  /** Legacy Windows clients keep probing WSL until true; remove only after their compatibility window. */
  windowsProcessStartTimeAvailable?: boolean
  /** Absent on older hosts; missing degradation reports never prove all optional features work. */
  degradations?: RuntimeDegradation[]
  appVersion?: string
  remoteUpdateSupport?: RemoteServerUpdateSupport
  remoteControl?: RemoteRuntimeSharedConnectionDiagnostics | null
  hostPlatform?: NodeJS.Platform
  /** Optional display name reported by the answering runtime. */
  machineName?: string
  /** Absent from older hosts and from hosts whose profile could not persist an installation id. */
  hostDescriptor?: RuntimeHostDescriptor
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
  /** This process's Orca session ID when it runs as an Orca session; see `CliStatusCaller`. */
  caller?: CliStatusCaller
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
  /** True when this leaf is retained by a parked PTY watcher, not mounted in the renderer. */
  parked?: boolean
}

/** Layout-owner builds: a pane the window shows of a workspace main owns. */
export type RuntimeMountedLeaf = {
  tabId: string
  leafId: string
  paneRuntimeId: number
  /** Retained by a parked PTY watcher, not mounted in the renderer. */
  parked?: boolean
  /** The pane's title as the window resolves it, a reset of a stuck agent title included. */
  paneTitle?: string | null
}

export type RuntimeSyncWindowGraph = {
  tabs: RuntimeSyncedTab[]
  leaves: RuntimeSyncedLeaf[]
  /** Layout-owner windows report main-owned panes here; tabs/leaves then cover other workspaces. Window-to-main only. */
  mountedLeaves?: RuntimeMountedLeaf[]
  mobileSessionTabs?: RuntimeMobileSessionTabsSnapshot[]
  unchangedMobileSessionWorktrees?: string[]
  /** Shown tab-group grids let main size new terminals; window-to-main only, never copied into session tabs. */
  terminalGroupGridSizes?: Record<string, { cols: number; rows: number }>
  /** The grid a workspace with a single tab group gets, for one the window is not showing. */
  singleGroupWorkspaceGridSize?: { cols: number; rows: number }
  /** Merge changed workspace selections; absent leaves prior entries, null means none shown. Layout-owner builds only. */
  activeGroupByWorkspace?: Record<string, string | null>
  /** The sidebar's Project grouping inputs for paired phones; sent only when they changed. */
  projectSectionCatalog?: MobileProjectSectionCatalog
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
  /** Proven host retirement; delegated and legacy replies omit this receipt. */
  retirementConfirmed?: true
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

/** Placeholder epoch before first publication, optionally navigation-suffixed: “ask later”, never evidence tabs closed. */
export const UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH = 'none'

/** Suffix a host appends to the epoch when projecting a snapshot for one paired client's navigation. */
export const CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX = ':client-navigation'

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
  /** Query-only truth about an executing launch that owns this workspace's first surface. */
  initialSurfaceLaunch?: { launchId: string; agent: TuiAgent }
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
  /** After restart, client-hosted browser rows may be unknown while terminals are authoritative. Preserve absent
   * client-hosted rows until reattachment; clear this flag on host attach or deadline so absent hosts cannot hold rows forever. */
  clientHostedPagesUnreconciled?: true
  /** Unreadable chat journals leave chat rows unverifiable while other rows remain authoritative. Preserve absent
   * chat tabs until host restore; no deadline because the chats remain durable on disk. */
  agentSessionsUnverifiable?: true
}

export type RuntimeMobileSessionCreateTerminalResult = {
  tab: RuntimeMobileSessionTerminalClientTab
  publicationEpoch: string
  snapshotVersion: number
  warning?: 'desktop-tab-not-shown'
  /** The saved folder was gone, so the terminal started at the workspace root. */
  startupCwdFallback?: 'workspace-root'
}

/** Activation's reply: the fallback rides this one answer and is never stored on the snapshot. */
export type RuntimeMobileSessionTabActivationResult = RuntimeMobileSessionTabsResult &
  Pick<RuntimeMobileSessionCreateTerminalResult, 'startupCwdFallback'>

export type RuntimeMobileSessionTabsRemovedResult = RuntimeMobileSessionTabsResult & {
  removed: true
  activeGroupId: null
  activeTabId: null
  activeTabType: null
  tabs: []
}
