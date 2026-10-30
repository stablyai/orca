import type { TerminalLaunchResult } from './agent-session-resume'
import type { ExecutionHostId } from './execution-host'
import type { StartupCwdFallback } from './startup-cwd-fallback'

export type RuntimeTerminalCreate = TerminalLaunchResult & {
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
