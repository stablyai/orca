// Whether a structured chat offers Stop, and what Stop does, from what this view knows of the chat.
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { hasUnsentStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox-stop-withdrawal'

export function structuredAgentSessionStopControl(input: {
  /** The host has published this chat to this view. */
  published: boolean
  /** The Stop the host is asked for once it has published this chat. */
  host: {
    /** The host takes a Stop naming no turn (and this view holds its fence). */
    stopsConversation: boolean
    stop: (turnId: string | null, withdrawUnsent: () => void) => Promise<unknown>
  }
  transportState: {
    turnId: string | null
    isWorking: boolean
    submissions: readonly AgentJournalSubmission[]
  }
  /** This client's sends the host may not have taken yet. */
  outbox: { outbox: readonly StructuredAgentSessionOutboxEntry[]; withdrawUnsent: () => void }
}): { canStop: boolean; stop: () => Promise<unknown> } {
  const { published, host } = input
  const { turnId, isWorking, submissions } = input.transportState
  const { withdrawUnsent } = input.outbox
  const holdsUnsent = hasUnsentStructuredAgentSessionOutboxEntry(input.outbox.outbox, submissions)
  return {
    // Before the host publishes this chat to this view, nothing sent has reached it: a Stop takes
    // back what this client holds, so a start that never answers cannot hold the message hostage.
    canStop:
      turnId !== null ||
      (!published && holdsUnsent) ||
      (host.stopsConversation && (isWorking || holdsUnsent)),
    stop: () => {
      if (!published) {
        withdrawUnsent()
        return Promise.resolve(null)
      }
      return host.stop(turnId, withdrawUnsent)
    }
  }
}
