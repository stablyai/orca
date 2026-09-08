import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import { transitionOutbox } from './structured-agent-session-outbox-transitions'

export function enqueueStructuredAgentSessionLaunchPrompt(
  sessionId: string,
  text: string
): StructuredAgentSessionOutboxEntry | null {
  const entry = createStructuredAgentSessionOutboxEntry({
    clientMessageId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
    sessionId,
    text,
    attachments: [],
    queuedAt: Date.now()
  })
  const result = transitionOutbox(sessionId, (entries) => [...entries, entry])
  return result.ok
    ? result.entries.find((candidate) => candidate.clientMessageId === entry.clientMessageId)!
    : null
}

export function discardStructuredAgentSessionLaunchOutbox(sessionId: string): void {
  transitionOutbox(sessionId, () => [])
}
