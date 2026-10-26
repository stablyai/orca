import type * as AgentSessionResume from './agent-session-resume'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import type { ExecutionHostId } from './execution-host'
import type { PtyIncarnationId } from './pty-incarnation'
import type { PtyLivenessVerdict } from './pty-liveness-verdict'
import type { RuntimeListingHostScope } from './runtime-listing-host-scope'
import type { RuntimeMobileSessionTabsResult } from './runtime-session-contracts'
import type { StartupCwdFallback } from './startup-cwd-fallback'
import type { TabGroupLayoutNode } from './tab-types'
import type { TerminalExitCause } from './terminal-exit-cause'
import type { TerminalPaneLayoutNode } from './terminal-tab-types'
import type { TerminalAgent, TuiAgent } from './terminal-agent'
export type {
  RuntimeTerminalSend,
  RuntimeTerminalPromptStage,
  RuntimeTerminalPromptDelivery
} from './runtime-terminal-send-contract'

export type RuntimeTerminalSummary = {
  handle: string
  ptyId: string | null
  incarnationId?: string | null
  orphaned?: boolean
  /** Orphaned PTY’s last recorded pane may survive in its owning renderer despite graph omission; absent if unknown/old host. */
  recordedPaneKey?: string
  worktreeId: string
  worktreePath: string
  branch: string
  tabId: string
  leafId: string
  title: string | null
  /** A user's name for this pane from the host's saved layout; absent when unset or the host predates it. */
  paneTitle?: string
  connected: boolean
  writable: boolean
  lastOutputAt: number | null
  preview: string
  /** Host-resolved observed agent identity; absent when unknown. Does not imply launch support. */
  agentIdentity?: TerminalAgent
  /** Absent while running or when the host predates the field; never infer a clean finish. */
  exitCause?: TerminalExitCause
  /** Absent when the host predates the field or could not name the execution host. */
  executionHostId?: ExecutionHostId
  /** Read verdict for host liveness: legacy connected can stay true while unreachable. Absent on older hosts. */
  verdict?: PtyLivenessVerdict['status']
}

export type RuntimeTerminalVisualTerminalNode = {
  type: 'terminal'
  handle: string
  tabId: string
  leafId: string
  title: string | null
  connected: boolean
  active: boolean
}

export type RuntimeTerminalVisualPaneNode =
  | RuntimeTerminalVisualTerminalNode
  | {
      type: 'pane-split'
      direction: Extract<TerminalPaneLayoutNode, { type: 'split' }>['direction']
      first: RuntimeTerminalVisualPaneNode
      second: RuntimeTerminalVisualPaneNode
    }

export type RuntimeTerminalVisualTab = {
  tabId: string
  title: string | null
  activeLeafId: string | null
  panes: RuntimeTerminalVisualPaneNode
}

export type RuntimeTerminalVisualGroupNode = {
  type: 'group'
  groupId: string | null
  activeTabId: string | null
  tabs: RuntimeTerminalVisualTab[]
}

export type RuntimeTerminalVisualLayoutNode =
  | RuntimeTerminalVisualGroupNode
  | {
      type: 'split'
      direction: Extract<TabGroupLayoutNode, { type: 'split' }>['direction']
      first: RuntimeTerminalVisualLayoutNode
      second: RuntimeTerminalVisualLayoutNode
    }

export type RuntimeTerminalVisualLayout = {
  worktreeId: string
  worktreePath: string
  root: RuntimeTerminalVisualLayoutNode
}

/** The shared listing-scope shape, kept under its incumbent name for existing consumers. */
export type RuntimeTerminalListHostScope = RuntimeListingHostScope

export type RuntimeTerminalListResult = {
  terminals: RuntimeTerminalSummary[]
  visualLayouts?: RuntimeTerminalVisualLayout[]
  topologyRevisions?: Record<string, number>
  totalCount: number
  truncated: boolean
  /** Absent from hosts that predate the field; treat that scope as unverifiable. */
  hostScope?: RuntimeTerminalListHostScope
}

export type RuntimeTerminalOrphanAdoptionClaim = {
  terminal: string
  ptyId: string
  incarnationId: PtyIncarnationId
  tabId: string
  leafId: string
}

export type RuntimeTerminalOrphanTopologyTab = {
  tabId: string
  root: TerminalPaneLayoutNode
  activeLeafId: string
  expandedLeafId: string | null
}

export type RuntimeTerminalOrphanTopologyGroup = {
  id: string
  activeTabId: string
  tabOrder: string[]
  recentTabIds?: string[]
}

export type RuntimeTerminalOrphanTopology = {
  tabs: RuntimeTerminalOrphanTopologyTab[]
  groups: RuntimeTerminalOrphanTopologyGroup[]
  groupLayout?: TabGroupLayoutNode
}

export type RuntimeTerminalOrphanAdoptionRequest = {
  worktree: string
  expectedTopologyRevision: number
  claims: RuntimeTerminalOrphanAdoptionClaim[]
  activeTabId?: string
  activeGroupId?: string
  topology?: RuntimeTerminalOrphanTopology
}

export type RuntimeTerminalOrphanAdoptionResult = {
  adopted: boolean
  topologyRevision: number
  snapshot: RuntimeMobileSessionTabsResult
}

export type RuntimeWorktreeTerminalSleepResult = {
  stopped: number
  stoppedPtyIds: string[]
  livePtyIds: string[]
} & (
  | { postStopVerified: true; postStopFailure?: never; remainingLivePtyIds?: never }
  | {
      postStopVerified: false
      postStopFailure: 'terminal_liveness_unavailable'
      remainingLivePtyIds?: never
    }
  | {
      postStopVerified: false
      postStopFailure: 'terminal_worktree_sleep_still_live'
      remainingLivePtyIds: string[]
    }
)

export type RuntimeWorktreeTerminalCloseResult = {
  closed: number
  stopped: number
  retiredSurfaces: true
  ptyStopVerdict?: 'live' | 'unverifiable'
  ptyStopReason?: string
}

export type RuntimeTerminalInteractiveWaitSource = 'hook' | 'prompt-text' | 'title'

export type RuntimeTerminalInteractiveWait = {
  source: RuntimeTerminalInteractiveWaitSource
  reason?: RuntimeTerminalWaitBlockedReason
  since?: number
}

export type RuntimeTerminalShow = RuntimeTerminalSummary & {
  paneRuntimeId: number
  ptyId: string | null
  rendererGraphEpoch: number
  /** Null means evaluated with no wait; absent means not evaluated. */
  agentWait?: RuntimeTerminalInteractiveWait | null
}

export type RuntimeTerminalState = 'running' | 'exited' | 'unknown'

export type RuntimeTerminalRowMetadata = {
  wrapped: boolean
  trailingSpaces: number
}

export type RuntimeTerminalRead = {
  handle: string
  status: RuntimeTerminalState
  tail: string[]
  /** Execution-host wrap evidence, aligned with tail; absent on older peers. */
  tailRows?: RuntimeTerminalRowMetadata[]
  truncated: boolean
  limited?: boolean
  oldestCursor?: string
  nextCursor: string | null
  latestCursor?: string
  returnedLineCount?: number
  source?: 'stream' | 'screen' | 'screen-unavailable'
  /** UI-only composer text, excluded from `tail`. */
  draft?: string
}

export type RuntimeTerminalRename = {
  handle: string
  tabId: string
  title: string | null
}

export type RuntimeTerminalSetPaneTitle = {
  handle: string
  tabId: string
  leafId: string
  title: string | null
}

export type RuntimeTerminalAgentStatusState = 'working' | 'permission' | 'idle' | null

export type RuntimeTerminalAgentStatus = {
  handle: string
  isRunningAgent: boolean
  status: RuntimeTerminalAgentStatusState
}

export type RuntimeTerminalPresentation = 'background' | 'focused'

type RuntimeTerminalCreateBaseRequestPayload = {
  requestId: string
  worktreeId?: string
  afterTabId?: string
  targetGroupId?: string
  command?: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: AgentSessionResume.SleepingAgentLaunchConfig
  resumeProviderSession?: AgentSessionResume.AgentProviderSessionMetadata
  launchToken?: string
  launchAgent?: TuiAgent
  viewMode?: 'terminal' | 'chat'
  startupCommandDelivery?: StartupCommandDelivery
  title?: string
  activate?: boolean
  presentation?: RuntimeTerminalPresentation
  surfaceOwner?: false
  /** Windows shell the created tab spawns AS, instead of the host default. */
  shellOverride?: string
}

export type RuntimeTerminalCreateRequestPayload =
  | (RuntimeTerminalCreateBaseRequestPayload & { source?: undefined })
  | (RuntimeTerminalCreateBaseRequestPayload & {
      worktreeId: string
      source: 'runtime-session'
    })

export type RuntimeTerminalCreate = {
  handle: string
  /** Host-owned PTY incarnation used to fence remote identity observations. */
  incarnationId?: string | null
  tabId?: string
  paneKey?: string | null
  ptyId?: string | null
  worktreeId: string
  title: string | null
  executionHostId?: ExecutionHostId
  hostPlatform?: NodeJS.Platform
  surface?: 'background' | 'visible'
  warning?: string
  agentSessionDisposition?: 'created' | 'adopted'
  isReattach?: true
  /** Spawn process identity for host-internal ownership proof. */
  processId?: number
  /** Host-internal: the requested folder was gone, so the process started at the workspace root. */
  startupCwdFallback?: StartupCwdFallback
  /** Host-internal saved-folder decision; excluded by RPC result projection. */
  savedStartupCwd?: string
}

export type RuntimeTerminalSplit = {
  handle: string
  tabId: string
  paneRuntimeId: number
  // Why: paired callers need the host-created leaf identity to focus the exact pane.
  leafId?: string
}

export type RuntimeTerminalResolvePane = {
  handle: string
  /** Host-owned PTY incarnation used to fence remote identity observations. */
  incarnationId?: string | null
  tabId: string
  leafId: string
  ptyId: string | null
  connected?: boolean
  worktreeId?: string
  executionHostId?: ExecutionHostId
  hostPlatform?: NodeJS.Platform
}

export type RuntimeTerminalFocus = {
  handle: string
  tabId: string
  worktreeId: string
  navigated?: boolean
}

export type RuntimeTerminalClose = {
  handle: string
  tabId: string
  closeMode?: 'tab'
  ptyKilled: boolean
  ptyStopVerdict?: 'live' | 'unverifiable'
  ptyStopReason?: string
  /** Durable host kill order replays on SSH reconnect; promise kill replay only when the host reports this field. */
  pendingKillRecorded?: true
}

export type RuntimeTerminalWaitCondition = 'exit' | 'tui-idle'

// Keep published codex-* reasons readable forever; emit them only for plausibly Codex-specific wording.
// Agent-agnostic matchers use agent-* reasons.
export type RuntimeTerminalWaitBlockedReason =
  | 'codex-update-prompt'
  | 'codex-trust-workspace'
  | 'codex-cwd-prompt'
  | 'codex-model-migration-prompt'
  | 'codex-hooks-review-prompt'
  | 'codex-interactive-prompt'
  | 'agent-update-prompt'
  | 'agent-trust-workspace'
  | 'agent-cwd-prompt'
  | 'agent-hooks-review-prompt'
  | 'agent-interactive-prompt'
  | 'agent-approval-prompt'

export type RuntimeTerminalWait = {
  handle: string
  condition: RuntimeTerminalWaitCondition
  satisfied: boolean
  status: RuntimeTerminalState
  exitCode: number | null
  exitCause?: TerminalExitCause
  blockedReason?: RuntimeTerminalWaitBlockedReason
}
