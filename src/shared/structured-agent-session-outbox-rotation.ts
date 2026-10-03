// A message the outbox sends again under a new id keeps the ids it replaced: the journal's rows
// under them are this message's, so the chat never draws them beside it.

import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'

/** The message under a new id, remembering the one it replaces. */
export function rotateStructuredAgentSessionOutboxEntryId(
  entry: StructuredAgentSessionOutboxEntry,
  clientMessageId: string
): StructuredAgentSessionOutboxEntry {
  return {
    ...entry,
    clientMessageId,
    rotatedFrom: [...(entry.rotatedFrom ?? []), entry.clientMessageId]
  }
}

/** The replaced ids a saved entry carries; a malformed list is dropped. */
export function parseStructuredAgentSessionOutboxRotation(entry: {
  rotatedFrom?: unknown
}): Pick<StructuredAgentSessionOutboxEntry, 'rotatedFrom'> {
  const { rotatedFrom } = entry
  return Array.isArray(rotatedFrom) && rotatedFrom.every((id) => typeof id === 'string')
    ? { rotatedFrom }
    : {}
}
