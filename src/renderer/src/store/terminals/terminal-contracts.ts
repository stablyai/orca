import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionHydrationOptions } from '@/lib/workspace-session-hydration-keys'
import type { HostSessionSlices } from '@/lib/workspace-session-host-split'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'

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
