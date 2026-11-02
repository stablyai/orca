/** Build exit causes only from observed evidence: stop paths synthesize codes, node-pty reports 0 for signals,
 * and macOS login reports its own status (STA-4536, STA-4603). Missing evidence stays unknown. */
export type TerminalExitCause =
  /** Teardown was requested through Orca — a close, a stop, a worktree removal. Not a failure. */
  | { kind: 'operator_close' }
  /** The host reported a signal. The agent did not choose to stop. */
  | { kind: 'signaled'; signal: number }
  /** The process ended on its own and the host vouched for the status. */
  | {
      kind: 'exited'
      exitCode: number
      initialOutputDiagnostic?: 'git-bash-console-capacity'
    }
  /** Nothing here is provable. Never narrow this by guessing. */
  | { kind: 'unknown'; reason: TerminalExitUnknownReason }

export type TerminalExitUnknownReason =
  /** A stop was issued and no exit was ever observed, so the process may still be alive. */
  | 'stop_unverified'
  /** The host cannot report its child's status at all (see {@link hostReportsChildExitStatus}). */
  | 'host_status_unavailable'
  /** Older daemons/SSH relays report only a code; zero cannot distinguish a clean exit from a signal. */
  | 'cause_unreported'

export const OPERATOR_CLOSE_EXIT_CAUSE: TerminalExitCause = { kind: 'operator_close' }

/** Lost-contact sentinel, rejected as proof of death. Default omitted host status to this, never 0. */
export const UNVERIFIED_PROCESS_EXIT_CODE = -1

/** A wrapper’s status/signal cannot establish the child’s cause when hostReportsChildExitStatus is false. */
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
  // Negative stop sentinels record an unverified stop request, not observed death.
  if (observation.exitCode < 0) {
    return { kind: 'unknown', reason: 'stop_unverified' }
  }
  return { kind: 'exited', exitCode: observation.exitCode }
}

/** Older daemons/SSH relays omit causes. Zero is ambiguous (signal or wrapper result); nonzero retains the exit status. */
export function resolveUnreportedExitCause(exitCode: number): TerminalExitCause {
  if (exitCode < 0) {
    return { kind: 'unknown', reason: 'stop_unverified' }
  }
  return exitCode === 0
    ? { kind: 'unknown', reason: 'cause_unreported' }
    : { kind: 'exited', exitCode }
}

export function describeTerminalExitCause(cause: TerminalExitCause): string {
  switch (cause.kind) {
    case 'operator_close':
      return 'Terminal closed by operator request'
    case 'signaled':
      return `Agent process killed by signal ${cause.signal}`
    case 'exited':
      return `Agent process exited with code ${cause.exitCode}`
    case 'unknown':
      switch (cause.reason) {
        case 'stop_unverified':
          return 'Agent process stop was requested but never confirmed'
        case 'host_status_unavailable':
          return 'Agent process ended; this host cannot report why'
        case 'cause_unreported':
          return 'Agent process ended; the reporting host did not say why'
      }
  }
}

export function isDeliberateTerminalExit(cause: TerminalExitCause): boolean {
  return cause.kind === 'operator_close'
}

/** Nonnegative host status proves the process ended even when its cause is unknown; negative sentinels require unverifiable cleanup.
 * Do not gate on hostReportsChildExitStatus or signal: macOS login hides the cause but waits for its shell, so its exit proves death. */
export function isProvenProcessExit(exitCode: number): boolean {
  return resolveProcessExitCause({ exitCode }).kind !== 'unknown'
}
