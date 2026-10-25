import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'

type HostTerminalExitFacts = Partial<
  Pick<RuntimeTerminalSummary, 'verdict' | 'exitCause' | 'connected'>
>

/**
 * True only when the execution host itself recorded this terminal's exit. A host's verdict wins;
 * a host that sends no verdict still counts when it records an observed exit for a terminal
 * it reports disconnected. Anything else (no answer, unverifiable, an older host) proves nothing.
 */
export function hostRecordsTerminalExit(
  terminal: HostTerminalExitFacts | null | undefined
): boolean {
  if (!terminal) {
    return false
  }
  if (terminal.verdict !== undefined) {
    return terminal.verdict === 'exited'
  }
  const cause = terminal.exitCause
  if (!cause || terminal.connected !== false) {
    return false
  }
  // Why: stop_unverified is a stop nobody saw land, so the process may still run.
  return !(cause.kind === 'unknown' && cause.reason === 'stop_unverified')
}

/** A same-handle restart shows up only as a new PTY or incarnation, so a known mismatch is a replacement. */
export function sameWhenBothKnown(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  return !left || !right || left === right
}
