import type {
  AgentHookRelayEnvelope,
  AgentHookUnavailableEnvelope
} from '../shared/agent-hook-relay'
import type { TmuxManagedPty } from '../shared/tmux-agent-hook-owner'

/** `evidenceOnly`: a batch that changes no row here; it must not supersede the pane's pending row snapshot. */
export type RelayHookForward = (
  envelope: AgentHookRelayEnvelope,
  options?: { evidenceOnly?: true }
) => void

export type RelayHookServerOptions = {
  /** Where to put endpoint.env / endpoint.cmd. Defaults to `$HOME/.orca-relay/agent-hooks`. */
  endpointDir?: string
  // Default remote tag avoids main’s dev/prod mismatch warnings.
  env?: string
  // WSL passes the host token via WSLENV for unmodified hook clients; otherwise generate a UUID.
  token?: string
  // Prefer the Windows listener’s port for env-discovered WSL hooks; fall back to ephemeral if occupied.
  preferredPort?: number
  forwardUnavailable?: (envelope: AgentHookUnavailableEnvelope) => void
  forward: RelayHookForward
  forwardClaudeAgentView?: (body: unknown) => Promise<unknown>
  // Retired pane posts own no client surface; absent this callback, forward everything for legacy listeners without PTY state.
  getTmuxManagedPty?: (paneKey: string) => Promise<TmuxManagedPty | null>
  /** Token captured from the successful host spawn; absent authority keeps the physical poster. */
  getAgentLaunchToken?: (paneKey: string) => string | undefined
  isPaneSurfaceRetired?: (paneKey: string) => boolean
}

export type RelayHookServerStartOptions = {
  publishEndpoint?: boolean
}
