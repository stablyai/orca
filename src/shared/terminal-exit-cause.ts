/**
 * Why a terminal's process is gone.
 *
 * Orca used to record one number and let every reader guess. That number is not
 * evidence: the stop paths synthesize it, node-pty reports 0 for a signalled
 * death, and macOS's TCC `login(1)` wrapper returns its own status instead of
 * the shell's. A clean finish, an OOM kill and an operator close all arrived as
 * "code 0" (STA-4536, STA-4603).
 *
 * So a cause is only ever built from evidence someone actually holds, and the
 * absence of evidence is spelled `unknown` rather than guessed.
 */
export type TerminalExitCause =
  /** Teardown was requested through Orca — a close, a stop, a worktree removal. Not a failure. */
  | { kind: 'operator_close' }
  /** The host reported a signal. The agent did not choose to stop. */
  | { kind: 'signaled'; signal: number }
  /** The process ended on its own and the host vouched for the status. */
  | { kind: 'exited'; exitCode: number }
  /** Nothing here is provable. Never narrow this by guessing. */
  | { kind: 'unknown'; reason: TerminalExitUnknownReason }

export type TerminalExitUnknownReason =
  /** A stop was issued and no exit was ever observed, so the process may still be alive. */
  | 'stop_unverified'
  /** The host cannot report its child's status at all (see {@link hostReportsChildExitStatus}). */
  | 'host_status_unavailable'

export const OPERATOR_CLOSE_EXIT_CAUSE: TerminalExitCause = { kind: 'operator_close' }

/**
 * Build a cause from what the host actually observed.
 *
 * `hostReportsChildExitStatus: false` means the number and signal below describe
 * a wrapper process, not the agent — so they are dropped rather than reported.
 */
export function resolveProcessExitCause(observation: {
  exitCode: number
  signal?: number | null
  hostReportsChildExitStatus?: boolean
}): TerminalExitCause {
  if (observation.hostReportsChildExitStatus === false) {
    return { kind: 'unknown', reason: 'host_status_unavailable' }
  }
  if (typeof observation.signal === 'number' && observation.signal > 0) {
    return { kind: 'signaled', signal: observation.signal }
  }
  // Why: the stop paths pass a negative code to mean "we asked it to stop and
  // never saw it die". That is an absence of evidence, not an exit status.
  if (observation.exitCode < 0) {
    return { kind: 'unknown', reason: 'stop_unverified' }
  }
  return { kind: 'exited', exitCode: observation.exitCode }
}

/** One line an operator or a coordinating agent can read without decoding a number. */
export function describeTerminalExitCause(cause: TerminalExitCause): string {
  switch (cause.kind) {
    case 'operator_close':
      return 'Terminal closed by operator request'
    case 'signaled':
      return `Agent process killed by signal ${cause.signal}`
    case 'exited':
      return `Agent process exited with code ${cause.exitCode}`
    case 'unknown':
      return cause.reason === 'stop_unverified'
        ? 'Agent process stop was requested but never confirmed'
        : 'Agent process ended; this host cannot report why'
  }
}

/** True when a dispatch that ended this way was torn down deliberately rather than lost. */
export function isDeliberateTerminalExit(cause: TerminalExitCause): boolean {
  return cause.kind === 'operator_close'
}
