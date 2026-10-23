import type { ExecutionHostId } from './execution-host'
import type { StartupCwdFallback } from './startup-cwd-fallback'

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

/** True only for a reply on this contract that says this call made the terminal; anything else is not. */
export function isTerminalCreatedHere(
  reply: Partial<Record<'isReattach' | 'agentSessionDisposition', unknown>>
): boolean {
  const { isReattach, agentSessionDisposition: disposition } = reply
  return isReattach === undefined && (disposition === undefined || disposition === 'created')
}
