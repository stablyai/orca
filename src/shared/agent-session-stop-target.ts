import type { AgentJournalSubmission } from './agent-session-journal-types'
import { isUnansweredStructuredAgentSessionDispatch } from './structured-agent-session-unanswered-dispatch'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { parseAgentJournalItemKey } from './agent-session-journal-item-key'
import type { AgentSessionBackgroundStopTarget } from './agent-session-background-stop-target'

export type AgentSessionStopTarget =
  | { kind: 'turn'; turnId: string }
  | { kind: 'submission'; clientMessageId: string }
  | AgentSessionBackgroundStopTarget

/** Capture the host-published identity at the press, before capability discovery can await. */
export function agentSessionStopTarget(
  turnId: string | null,
  submissions: readonly AgentJournalSubmission[],
  fence: number | null
): AgentSessionStopTarget | undefined {
  if (turnId) {
    return { kind: 'turn', turnId }
  }
  // A queued send never started, so it is no Stop target: the unnamed Stop withdraws it.
  const submission = submissions.findLast(
    (entry) =>
      !isQueuedAgentJournalSubmission(entry) &&
      isUnansweredStructuredAgentSessionDispatch(entry, fence)
  )
  return submission
    ? { kind: 'submission', clientMessageId: submission.clientMessageId }
    : undefined
}

/** A submission target stops only work still awaiting its turn, never a later turn. Decided by the
 *  named send's own state: whatever was sent after it does not end it. */
export function agentSessionStopTargetIsLive(
  target: AgentSessionStopTarget,
  activeTurnId: string | null,
  submissions: readonly AgentJournalSubmission[],
  fence: number,
  activeUserItemId?: string
): boolean {
  if (target.kind === 'turn') {
    return target.turnId === activeTurnId
  }
  if (target.kind === 'background-tasks') {
    return true
  }
  return submissions.some((entry) => {
    if (entry.clientMessageId !== target.clientMessageId) {
      return false
    }
    if (activeTurnId === null) {
      return isUnansweredStructuredAgentSessionDispatch(entry, fence)
    }
    if (entry.providerItemId !== null && entry.providerItemId === activeUserItemId) {
      return entry.fence === fence
    }
    const identity = entry.providerItemId ? parseAgentJournalItemKey(entry.providerItemId) : null
    const turnId =
      identity?.provider === 'codex'
        ? identity.turnId
        : identity?.provider === 'claude'
          ? identity.uuid
          : null
    return turnId === activeTurnId && entry.fence === fence
  })
}
