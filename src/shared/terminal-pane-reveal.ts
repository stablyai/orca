import type { ExecutionHostId } from './execution-host'

/** Use stable pane IDs: paired-server handles exist only on that server. */
export type TerminalPaneRevealTarget = {
  worktreeId: string
  tabId: string
  leafId: string | null
  /** The host that owns the worktree, for when the same id is known on more than one host. */
  executionHostId: ExecutionHostId | null
}

export type TerminalPaneRevealRequest = TerminalPaneRevealTarget & { requestId: string }

export type TerminalPaneRevealReply = { requestId: string; revealed: boolean }

/** `navigated` is false when this window does not know the worktree. */
export type RuntimeTerminalReveal = TerminalPaneRevealTarget & { navigated: boolean }
