import type { TerminalExitCause } from './terminal-exit-cause'

/**
 * What a client is told about the last process of a terminal surface whose leaf main kept after
 * that process died. The leaf is the identity: a pane move changes its tab and keeps this, and the
 * leaf's next process ends it.
 */
export type TerminalSurfaceExit = {
  exitCode: number
  cause: TerminalExitCause
  exitedAt: number
}

/**
 * Main's record for a kept leaf. The dead process's ids stay on the host: only an older client's
 * retirement proof needs them, and anything published becomes a permanent wire contract.
 */
export type TerminalExitRecord = TerminalSurfaceExit & {
  worktreeId: string
  leafId: string
  ptyId: string
  incarnationId: string | null
  /** The runtime handle the process had, when one was issued; retirement proofs name it. */
  terminal?: string
}
