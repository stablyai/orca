import type { TerminalLaunchResult } from '../../agent-session/lifecycle/agent-session-resume'
import type { ExecutionHostId } from '../../execution-host/execution-host'
import type { StartupCwdFallback } from '../../shell/launch/startup-cwd-fallback'

export const SETUP_AGENT_GATE = Symbol('setup agent gate')
export type SetupAgentGateOutcome = 'started' | 'failed' | 'blocked'

export type RuntimeTerminalCreate = TerminalLaunchResult & {
  /** An unobserved gate outcome resolves to undefined. */
  [SETUP_AGENT_GATE]?: { outcome: Promise<SetupAgentGateOutcome | undefined>; blocked?: true }
  coldRestore?: { scrollback: string; cwd: string; cols?: number; rows?: number }
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
