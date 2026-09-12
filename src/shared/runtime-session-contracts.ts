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
import type { OrchestrationTaskStatus } from './orchestration-task-status'
import type { WorkerTerminalListState } from './worker-terminal-list-state'
import type { HostAvailableMemorySource } from './process-stats-types'
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
  /** True only when this Windows host can prove process creation times for PID ownership. */
  windowsProcessStartTimeAvailable?: boolean
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

/**
 * What one counted agent's turn is doing, as far as the runtime can prove it in a single
 * in-memory pass. `permission` is the established runtime name for "parked on a prompt that needs
 * a human"; `unknown` means an agent is present but no current turn evidence exists for it — it
 * is never a stand-in for idle.
 */
export type RuntimeServeStatsAgentState = 'working' | 'permission' | 'idle' | 'unknown'

/**
 * cgroup v2 pid-controller readings, straight from `/sys/fs/cgroup/pids.current` and
 * `/sys/fs/cgroup/pids.max`.
 *
 * `max: null` means the literal cgroup value `max` — no limit at all — and NOT "unmeasured": the
 * whole `RuntimeServeStatsHost.pids` object is null when nothing could be read, so this inner null
 * is unambiguous. The literal is never coerced to a number: 0 would read as "no pids allowed", and
 * Infinity does not survive JSON.
 */
export type RuntimeServeStatsHostPids = {
  /** `pids.current` — every task in this cgroup, so threads count too, not just processes. */
  current: number
  /** `pids.max` — the ceiling `current` is racing, or null for the literal `max` (unlimited). */
  max: number | null
}

/**
 * Host-wide CPU/memory pressure, reported alongside the Orca-scoped `counts`.
 *
 * This deliberately reverses #10608's "host CPU/RAM metrics" non-goal, and it lives under its own
 * key rather than inside `counts` because it is a different kind of measurement. #14552 and #19312
 * were both misdiagnosed as network faults for days: from the paired client the only symptom is
 * `Reconnecting to remote runtime`, while the host is in fact saturated (#19312 sustained a
 * 1-minute loadavg of 105-112 while systemd still reported the unit healthy/active).
 *
 * EVERY number here is HOST-WIDE, never Orca-attributed. The ~60 GiB RSS in #12588 belonged to a
 * terminal *child* process, not to the runtime, and it still degraded SSH and paired-runtime
 * availability — so `memoryAvailableBytes` must never be read as "Orca is using the rest".
 *
 * `null` means "this platform cannot measure it", and is NEVER interchangeable with 0: `os.loadavg()`
 * reports meaningless zeros on Windows, so a 0 there would read as an idle host. Readers MUST NOT
 * coerce null to 0.
 *
 * Cheap by construction: in-process `node:os` syscalls plus at most one `/proc/meminfo` read. No
 * subprocess, and explicitly not `collectMemorySnapshot`'s `ps` process-table sweep, so polling
 * `serve stats` stays something nobody regrets.
 */
export type RuntimeServeStatsHost = {
  /**
   * 1-minute load average, unnormalized — compare it against `cpuCoreCount` (#14552's "6.85 on 4
   * cores" is the shape of the read). `null` on Windows, which has no load average at all.
   */
  loadAverage1m: number | null
  cpuCoreCount: number
  memoryTotalBytes: number
  /**
   * Memory obtainable without material pressure. On Linux this is `/proc/meminfo` MemAvailable,
   * which is the real signal; `os.freemem()` excludes reclaimable page cache and so badly
   * understates what is actually available. `memoryAvailableSource` says which one you got.
   */
  memoryAvailableBytes: number
  /**
   * Which reading `memoryAvailableBytes` came from. Never `memory-pressure`: that darwin reading
   * needs a subprocess, which this path refuses.
   */
  memoryAvailableSource: HostAvailableMemorySource
  /**
   * SwapTotal - SwapFree from Linux `/proc/meminfo`; `null` on every other platform and on a Linux
   * container with no procfs. Swap in use is the #9229 / #14552 tell (19 kernel OOM kills in 30
   * days against a nearly full swap). 0 means "no swap in use"; `null` means "not measured here".
   */
  swapUsedBytes: number | null
  /**
   * cgroup v2 pid accounting for the cgroup this runtime runs in, or `null` where there is nothing
   * to read: non-Linux, cgroup v1, or a container with no `/sys/fs/cgroup` mount. Never 0 — a
   * zeroed `current` would claim a measured, empty cgroup.
   *
   * #18789 had 8,629 `clone()` calls rejected against `pids.max=4096` while `pids.current` sat
   * just under that ceiling, and neither `loadAverage1m` nor `memoryAvailableBytes` moved for it:
   * that host had 44 GB free while it could not fork. Pid exhaustion is invisible to every other
   * field here, which is why this one exists.
   */
  pids: RuntimeServeStatsHostPids | null
}

/** One long-poll admission pool: slots held right now, against the ceiling that sheds the next. */
export type RuntimeServeStatsLongPollPool = {
  active: number
  cap: number
}

/**
 * Long-poll admission state — the `runtime_busy` fence, made readable.
 *
 * #19342's operator hit `runtime_busy` on a host at loadavg 4.8 with 44 GB free, so nothing in the
 * host readings explained it: the limit that rejected them is this in-process slot budget, not the
 * machine. They could only find the cause by unpacking `app.asar` and reading the cap out of the
 * source. Both halves are therefore reported — `active` says how full a pool is, `cap` says what
 * it is full of — so the next rejection is self-diagnosing without a source dive.
 *
 * `total` fences every long poll; `ask` and `browserHost` are sub-pools of it, and `specialized`
 * is the combined ceiling those two share (an ask can be shed by `specialized` while `ask` itself
 * still has room). Admission checks them in exactly that order — see `admitLongPoll`.
 *
 * `null` when no RPC listener is serving: the counters and caps live on the RPC server, so an
 * un-started or stopped one has no budget to report, and `0/0` would read as a runtime that can
 * admit nothing.
 */
export type RuntimeServeStatsLongPolls = {
  total: RuntimeServeStatsLongPollPool
  ask: RuntimeServeStatsLongPollPool
  browserHost: RuntimeServeStatsLongPollPool
  specialized: RuntimeServeStatsLongPollPool
}

/** Whether this runtime can still service work — which process liveness cannot answer. */
export type RuntimeServeStatsHealth = {
  /**
   * 99th-percentile event loop delay in milliseconds (`perf_hooks.monitorEventLoopDelay`, which
   * reports nanoseconds). `null` when unmeasured — the monitor was never enabled, or no sample has
   * been recorded yet. Never 0 for "not measured": #19312's whole failure was that "every liveness
   * signal we had was green while the process was effectively unable to service new work" (new
   * WebSocket connections hung 15s+ while the unit reported healthy).
   *
   * RESET CADENCE — reset-on-read: each read reports the window since the previous read, or since
   * runtime start for the first read. A lifetime-cumulative percentile over a multi-day serve goes
   * stale-flat: one saturated hour is diluted to invisibility, and a long-past spike keeps
   * reporting forever. Both directions make the number uninterpretable, which is the #19312 trap.
   * The cost is that two concurrent readers split one window between them; `serve stats` is an
   * operator command, not a scrape target, so freshness is the better trade.
   */
  eventLoopDelayP99Ms: number | null
  /**
   * Long-poll slot occupancy against the configured caps, or `null` when no RPC listener is
   * serving. This is the second half of "can this runtime still service work": a runtime whose
   * event loop is idle still rejects every new long poll once `total.active` reaches `total.cap`
   * (#19342).
   */
  longPolls: RuntimeServeStatsLongPolls | null
}

// Why: live current-state counts for `orca serve stats --json`. Deliberately
// NOT StatsSummary (that is lifetime-cumulative "fun stats"). This shape is a
// stable contract once shipped — scripts/MOPs parse it, so version it if it
// must change.
export type RuntimeServeStatsResult = {
  version: string
  // Why: distinguishes "same runtime generation" from "restarted under me" — a
  // silent restart issues a new id and orphans the caller's pty handles (#9585).
  runtimeId: string
  uptimeSeconds: number
  // Why: the bound WebSocket serve port, or null when no WS listener is active
  // (WS disabled, or it failed to bind — e.g. a Unix-socket-only serve).
  port: number | null
  counts: {
    agents: number
    tasks: number
    terminals: number
    /**
     * Registered ptys that are not connected and that this runtime cannot prove exited: no
     * host-delivered exit frame ever reached the liveness register for them (a dropped relay, an
     * SSH provider that unregistered, an exit the owning host never confirmed).
     *
     * Loss of contact is never proof of death
     * (docs/reference/ssh-execution-boundary.md), so this count MUST NOT
     * authorize cleanup — it exists so leaked ptys stop being invisible. A pty
     * whose evidence fits neither bucket is counted here, the conservative side.
     */
    terminalsUnverifiable: number
    /**
     * Registered ptys that are not connected and that the owning host positively reported gone:
     * the liveness register holds an `exited` verdict (see PtyLivenessVerdict), whose only writer
     * is a host-delivered exit frame. These are proven dead, and separating them is what keeps
     * `terminalsUnverifiable`'s no-cleanup warning meaningful instead of routine.
     */
    terminalsExited: number
    worktrees: number
    /**
     * Every browser page this runtime holds, of both kinds: client-hosted pages in
     * RuntimeBrowserPageRegistry, plus the pages backed by a WebContents this process registered —
     * the renderer `<webview>` pages and the offscreen pages a headless serve creates. Counting
     * only the registry reported 0 for exactly the agent-opened headless tabs #14552 is about.
     * De-duplicated by page id, so a page known to both is counted once.
     */
    browserPages: number
    /**
     * The client-hosted subset whose host is gone. Each still pins one of the runtime's 256
     * registry page slots for the runtime's life — no TTL, no reaper.
     *
     * Scoped to client-hosted pages deliberately: retention here means "the host that could drive
     * this page left, and the slot stayed". A WebContents-backed page has no such host — this
     * process is its host — so it can never be retained in that sense, and inflating this number
     * with offscreen pages would misreport a leak. It is therefore a subset of `browserPages`,
     * never a partition of it.
     */
    browserPagesRetained: number
    /**
     * Resident-set total, in bytes, of the renderer OS processes backing the pages counted by
     * `browserPages` — or `null` when not one of them could be measured, which includes having no
     * pages at all (read `browserPages` to tell those two apart). Never 0.
     *
     * #14552's six agent-opened headless tabs included one 1.3 GB outlier, which is why
     * `browserPageMemoryMaxBytes` sits next to this: a total alone hides the single page that is
     * actually eating the host.
     *
     * Attributed per renderer process and de-duplicated by pid, because Electron may back several
     * pages with one renderer — summing per page would count a shared process twice. Linux only:
     * one `/proc/<pid>/status` VmRSS read per distinct pid, no subprocess and no `ps` table sweep
     * (the same polling discipline as `host`), so it is `null` on every other platform.
     */
    browserPageMemoryTotalBytes: number | null
    /**
     * The largest single renderer footprint behind `browserPages`, with the same measurement and
     * the same null rule as `browserPageMemoryTotalBytes`. This is the #14552 read: one page at
     * 1.3 GB among six is a different incident from six pages at 220 MB, and only the max
     * separates them.
     */
    browserPageMemoryMaxBytes: number | null
    /**
     * Every task row grouped by status, with all six statuses always present (0, never omitted).
     *
     * Deliberately does NOT sum to `counts.tasks`: that field counts live/resumable work only
     * (it excludes `completed` and `failed`, which persist in the table until an explicit reset).
     * The terminal statuses are exactly what #13047's operator had to hand-tabulate, so the
     * histogram keeps them.
     */
    tasksByStatus: Record<OrchestrationTaskStatus, number>
    /**
     * The `agents` count split by turn state. Sums to `counts.agents`.
     *
     * What each bucket can speak for depends on the population:
     * - Connected ptys with a resolved agent identity: `working` / `permission` / `idle` come
     *   from that pty's own current-incarnation evidence (retained hook status, then the prompt
     *   lifecycle tracker, then a title status observed live). A pty whose only status was
     *   observed in a previous incarnation, or which never reported one, counts as `unknown` —
     *   an identity resolving on a pane proves an agent is there, never what it is doing
     *   (#19548).
     * - Structured (native) agent sessions: always `unknown`. The session host proves liveness
     *   (live / unverifiable / exited), not turn state, and reading turn state would mean
     *   projecting each session's journal.
     */
    agentsByState: Record<RuntimeServeStatsAgentState, number>
    /**
     * Worker terminals grouped by process-accounting state, all six keys always present.
     *
     * This is the histogram #19388 and #18737 were hand-counted from: `reclaimable` is settled
     * work still holding a terminal, `release_unknown` is a release that could not be proven.
     * Scoped to every dispatch the DB retains, so it does not sum to `counts.tasks` or
     * `counts.terminals`; dispatches with no worker terminal at all are not counted here.
     */
    workersByTerminalState: Record<WorkerTerminalListState, number>
  }
  host: RuntimeServeStatsHost
  health: RuntimeServeStatsHealth
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
