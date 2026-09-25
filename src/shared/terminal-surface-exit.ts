import type { TerminalExitCause } from './terminal-exit-cause'

/**
 * The last process of a terminal surface whose leaf main kept after that process died. The leaf is
 * the identity: a pane move changes its tab and keeps this, and the leaf's next process ends it.
 */
export type TerminalSurfaceExit = {
  ptyId: string
  incarnationId: string | null
  /** The runtime handle the process had, when one was issued; retirement proofs name it. */
  terminal?: string
  exitCode: number
  cause: TerminalExitCause
  exitedAt: number
}

export type TerminalExitRecord = TerminalSurfaceExit & { worktreeId: string; leafId: string }
