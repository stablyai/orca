import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import {
  resumeFailureGuidance,
  resumeFailureSelectable
} from './native-chat-resume-failure-guidance'
import type { ResumeWorkspaceOwnership } from './native-chat-resume-ownership'
import type { RestartMachineKey } from './native-chat-restart-machines'

/**
 * Which offered chats the dialog has ticked, across machines.
 *
 * Tracked as the user's OVERRIDES over each row's default rather than as a selection, because each
 * machine's list is its host's and arrives — and shrinks — under an open dialog; a stored selection
 * would need re-seeding every time one changed. Keyed by machine and chat: two servers may hold
 * chats under the same id.
 */
export type ResumeSelectionOverrides = ReadonlyMap<string, boolean>

/** Ticks are keyed by the listing's identity, so a re-paired machine never inherits the old
 *  pairing's ticks for a chat that happens to share an id. */
export function resumeRowKey(identity: string, sessionId: string): string {
  return `${identity}\u0000${sessionId}`
}

/** One machine's listing: the machine and the pairing it was read under. */
export function restartListingIdentity(
  machine: RestartMachineKey,
  pairingRevision: number | undefined
): string {
  return `${machine}\u0000${pairingRevision ?? ''}`
}

/** Ticked by default: the user's own chat, unless it is a failure a retry cannot fix. */
export function resumeRowSelectedByDefault(
  ownership: ResumeWorkspaceOwnership,
  failure: ResumeFailure | undefined
): boolean {
  if (ownership !== 'own') {
    return false
  }
  if (!failure) {
    return true
  }
  const guidance = resumeFailureGuidance(failure)
  return guidance.primary === 'retry' || guidance.secondary === 'retry'
}

export type ResumeSelectionMachine = {
  machine: RestartMachineKey
  /** See `restartListingIdentity`. */
  identity: string
  rows: readonly ResumeCandidate[]
  failureFor: (sessionId: string) => ResumeFailure | undefined
  ownershipFor: (sessionId: string) => ResumeWorkspaceOwnership
}

/** The chats a tick can include on one machine; a failure the host marks unretryable never is. */
export function selectableResumeRows(machine: ResumeSelectionMachine): string[] {
  return machine.rows
    .filter((row) => {
      const failure = machine.failureFor(row.sessionId)
      return !failure || resumeFailureSelectable(failure)
    })
    .map((row) => row.sessionId)
}

/** Derived from each host's own list, so an action can never name a chat its host did not list. */
export function chosenResumeRows(
  machine: ResumeSelectionMachine,
  overrides: ResumeSelectionOverrides
): string[] {
  return selectableResumeRows(machine).filter(
    (sessionId) =>
      overrides.get(resumeRowKey(machine.identity, sessionId)) ??
      resumeRowSelectedByDefault(machine.ownershipFor(sessionId), machine.failureFor(sessionId))
  )
}

/** What Dismiss forgets on one machine, each chat named with the interruption it listed: only the
 *  user's own. Any other chat ends when it moves on, when its tab is closed, or by its own row's
 *  dismiss. */
export function dismissedRows(machine: ResumeSelectionMachine): string[] {
  return machine.rows
    .filter((row) => machine.ownershipFor(row.sessionId) === 'own')
    .map((row) => row.sessionId)
}
