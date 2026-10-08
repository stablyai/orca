import type { ExecutionHostId } from './execution-host'
import type { TerminalExitCause } from './terminal-exit-cause'
import type { TerminalAgent } from './terminal-agent'

export type RuntimeTerminalSummary = {
  handle: string
  ptyId: string | null
  incarnationId?: string | null
  orphaned?: boolean
  /**
   * Orphaned only: the pane the host last recorded for this PTY, which the renderer owning it can
   * still hold even when its graph omitted that pane. Absent when none was recorded or the host
   * predates the field.
   */
  recordedPaneKey?: string
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
  /** Host-resolved observed agent identity; absent when unknown. Does not imply launch support. */
  agentIdentity?: TerminalAgent
  /** Absent while running or when the host predates the field; never infer a clean finish. */
  exitCause?: TerminalExitCause
  /** Absent when the host predates the field or could not name the execution host. */
  executionHostId?: ExecutionHostId
}
