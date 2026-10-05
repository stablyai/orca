// Where an outbox entry's text came from when it was not the composer: an async question card
// answer keeps the per-question answers it sent, so a withdrawn answer goes back to the card,
// never into the composer draft.

export type StructuredAgentSessionOutboxOrigin = {
  kind: 'async-answer'
  /** Answer text by question key. */
  edits: Record<string, string>
}

export function parseStructuredAgentSessionOutboxOrigin(value: unknown): {
  origin?: StructuredAgentSessionOutboxOrigin
} {
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'async-answer') {
    return {}
  }
  const raw = 'edits' in value ? value.edits : undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const edits = Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
  return { origin: { kind: 'async-answer', edits } }
}

export function isStructuredAgentSessionAsyncAnswer(entry: {
  origin?: StructuredAgentSessionOutboxOrigin
}): boolean {
  return entry.origin?.kind === 'async-answer'
}
