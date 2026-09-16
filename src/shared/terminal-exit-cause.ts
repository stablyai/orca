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
  /**
   * The exit arrived from a source that reports a code but no cause — an SSH
   * relay, or a daemon older than this field. Its `0` may be a clean finish or
   * a signal; nothing here can tell, so nothing here claims to.
   */
  | 'cause_unreported'

export const OPERATOR_CLOSE_EXIT_CAUSE: TerminalExitCause = { kind: 'operator_close' }

/**
 * The code every surface uses for "contact was lost before the host could vouch
 * for this process". `resolveProcessExitCause` reads it as `stop_unverified`
 * and {@link isProvenProcessExit} rejects it.
 *
 * A reader handed an *optional* status by a host must default to this, never to
 * `0`: `exitCode ?? 0` mints a clean finish out of an absence of evidence.
 */
export const UNVERIFIED_PROCESS_EXIT_CODE = -1

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

/**
 * The cause for an exit delivered without one — an older daemon, or the SSH
 * relay, which forwards a code and nothing else.
 *
 * Zero is the ambiguous one, and the only one worth refusing: node-pty pairs it
 * with every signalled death, and a wrapper spawn returns it for any outcome at
 * all. A nonzero status is never fabricated that way, so it is still reported.
 */
export function resolveUnreportedExitCause(exitCode: number): TerminalExitCause {
  if (exitCode < 0) {
    return { kind: 'unknown', reason: 'stop_unverified' }
  }
  return exitCode === 0
    ? { kind: 'unknown', reason: 'cause_unreported' }
    : { kind: 'exited', exitCode }
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

/** True when a dispatch that ended this way was torn down deliberately rather than lost. */
export function isDeliberateTerminalExit(cause: TerminalExitCause): boolean {
  return cause.kind === 'operator_close'
}

/**
 * Whether an exit code is positive evidence that the process ended.
 *
 * Negative codes are synthetic stop sentinels; they mean that the host lost
 * contact before it could vouch for the child, so downstream cleanup must use
 * the `unverifiable` path instead of treating the tab as exited.
 *
 * This asks *whether* the process ended; the cause resolvers above ask *why*.
 * The two deliberately disagree about `0`, and that is not a defect:
 *
 * - `resolveUnreportedExitCause(0)` is `unknown` because a bare zero cannot
 *   distinguish a clean finish from a signal — an unknowable **reason**.
 * - `isProvenProcessExit(0)` is `true` because a host only forwards a
 *   non-negative code after its provider observed the process end — a known
 *   **fact of death**, whatever the reason.
 *
 * Do not route `hostReportsChildExitStatus` or `signal` through here to
 * "narrow" the zero. `login(1)` wraps every macOS local PTY once the TCC
 * preflight passes, so `hostReportsChildExitStatus` is false for essentially
 * all of them (macos-tcc-login-shell.ts) — yet login forks the shell and waits,
 * so its own exit *is* evidence the shell died. Treating those as unproven
 * would strand every macOS pane that a user closed with `exit`, which is the
 * mirror-image regression of reporting a lost host as exited.
 */
export function isProvenProcessExit(exitCode: number): boolean {
  return resolveProcessExitCause({ exitCode }).kind !== 'unknown'
}
