import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import type { DirectSshAuthority } from '../../../../shared/ssh-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionHydrationOptions } from '@/lib/workspace-session-hydration-keys'

/** In-memory recovery claim consumed only after the resumed terminal hook becomes live. */
export type AutomaticAgentResumeClaim = {
  worktreeId: string
  launchAgent: TuiAgent
  providerSession: AgentProviderSessionMetadata
}

export type CodexRestartNotice = {
  previousAccountLabel: string
  nextAccountLabel: string
  /** Labels are display-only; account ids disambiguate equal labels and A→B→A collapse. */
  previousAccountId?: string | null
  nextAccountId?: string | null
  /** Persists a home-route mismatch after ephemeral launch-account memory has expired. */
  homeRouteChanged?: true
  /** Accepted restart remains tracked so a failed execution can reopen instead of input-blocking invisibly. */
  restartRequested?: true
  /** Dismissal outlives the prompt while explicitly preventing that notice from blocking pane input. */
  dismissed?: true
}

/** Scoped direct-SSH hydration replaces only named workspace keys and authority. */
export type HydrateWorkspaceSessionOptions = {
  directSshAuthority?: DirectSshAuthority
  runtimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
} & WorkspaceSessionHydrationOptions

/** Scoped reconnect must still match this exact provider epoch and connection generation. */
export type ReconnectPersistedTerminalsOptions = {
  directSshAuthority: DirectSshAuthority
  workspaceKeys: readonly string[]
}
