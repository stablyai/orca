import type { AccountRestartCondition } from '../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import type {
  SleepingAgentLaunchConfig,
  AgentProviderSessionMetadata
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentAccountRestartResumeInput } from '@/lib/agent-session/accounts/agent-account-restart-startup'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionHydrationOptions } from '@/lib/workspace/persistence/workspace-session-hydration-keys'
import type { HostSessionSlices } from '@/lib/workspace/persistence/workspace-session-host-split'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'

export type TerminalCreationExecutionFacts = {
  hostId: ExecutionHostId
  connectionId: string | null
  platform: NodeJS.Platform
  isRemote: boolean
  isWsl: boolean
  projectRuntime?: ProjectExecutionRuntimeResolution
}

/** In-memory recovery claim consumed only after the resumed terminal hook becomes live. */
export type AutomaticAgentResumeClaim = {
  worktreeId: string
  launchAgent: TuiAgent
  providerSession: AgentProviderSessionMetadata
}

/** Agents whose panes restart in place onto a newly selected account. */
export type AccountRestartAgent = 'codex' | 'claude'

export type CodexRestartNotice = {
  incarnationId?: string
  previousAccountLabel: string
  nextAccountLabel: string
  /** Labels are display-only; account ids disambiguate equal labels and A→B→A collapse. */
  previousAccountId?: string | null
  nextAccountId?: string | null
  /** Accepted restart remains tracked so a failed execution can reopen instead of input-blocking invisibly. */
  restartRequested?: true
  /** Dismissal outlives the prompt while explicitly preventing that notice from blocking pane input. */
  dismissed?: true
}

export type HydrateWorkspaceSessionOptions = {
  runtimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
  /** Rows parked for hosts that lost a contested workspace id; omitted leaves the store's copy. */
  contestedHostWorkspaceSessions?: HostSessionSlices
  /** Partition each restored session key was read from; omitted leaves the store's copy. */
  contestedPrimaryHostBySessionKey?: Record<string, ExecutionHostId>
  /** Runtime partitions the cold read loaded; omitted leaves the store's copy. */
  hydratedRuntimeSessionHostIds?: ExecutionHostId[]
} & WorkspaceSessionHydrationOptions

export type CodexAccountRestart = {
  agent: 'codex'
  requestId: string
  attemptId: string
  executorId?: string
  worktreeId: string
  tabId: string
  tabCreatedAt: number
  leafId: string | null
  oldPtyId: string
  connectionId?: string | null
  oldIncarnationId?: string
  environmentId: string | null
  pairingRevision?: number
  runtimeId?: string
  cwd?: string
  shellOverride?: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  hostId: string
  hostEpoch?: string
  phase: 'accepted' | 'claimed' | 'dispatched' | 'deferred' | 'failed' | 'unresolved'
  startupInput: AgentAccountRestartResumeInput
  startup: {
    command: string
    startupCommandDelivery: 'shell-ready'
    launchAgent: 'codex' | 'claude'
    env?: Record<string, string>
    launchConfig?: SleepingAgentLaunchConfig
    resumeProviderSession?: AgentProviderSessionMetadata
  } | null
  resultPtyId?: string
  resultIncarnationId?: string
  condition?: AccountRestartCondition
  error?: string
}

export type PaneAccountRestart = AccountRestartAgent | CodexAccountRestart
