import type { ExecutionHostId } from './execution-host'
import type { TerminalExitCause } from './terminal-exit-cause'
import type { TuiAgent } from './tui-agent'

export type RuntimeTerminalSummary = {
  handle: string
  ptyId: string | null
  incarnationId?: string | null
  orphaned?: boolean
  worktreeId: string
  worktreePath: string
  branch: string
  tabId: string
  leafId: string
  title: string | null
  connected: boolean
  writable: boolean
  lastOutputAt: number | null
  preview: string
  /** Current visibility; absent when the host predates surface reporting. */
  surface?: 'background' | 'visible'
  /** Host-resolved agent identity for action consumers; absent when unknown or unsupported. */
  agentIdentity?: TuiAgent
  /** Absent while running or when the host predates the field; never infer a clean finish. */
  exitCause?: TerminalExitCause
  /** Absent when the host predates the field or could not name the execution host. */
  executionHostId?: ExecutionHostId
}
