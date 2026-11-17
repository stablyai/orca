import { markInterruptedTurnContinued } from '../startup/cold-restore-resume-startup'

/** The reattach sends its startup command to the server now: a `continue` it carries is spent. */
export function markReattachInterruptedTurnContinued(
  startup: { command?: string; interruptedTurnKey?: string } | null
): void {
  if (startup?.command) {
    markInterruptedTurnContinued(startup.interruptedTurnKey)
  }
}
