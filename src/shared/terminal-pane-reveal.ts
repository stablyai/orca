import type { ExecutionHostId } from './execution-host'

/**
 * A terminal pane named by worktree, tab and leaf rather than by handle. A pane on a paired server
 * has the same ids in this window, but its handle exists only on that server.
 */
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
