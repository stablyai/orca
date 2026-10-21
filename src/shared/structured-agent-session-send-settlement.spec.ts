import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import { structuredAgentSessionSettledSends } from './structured-agent-session-send-settlement'

function submission(clientMessageId: string, queuedMessageId?: string): AgentJournalSubmission {
  return {
    clientMessageId,
    ...(queuedMessageId ? { queuedMessageId } : {}),
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 1
  }
}

describe('structuredAgentSessionSettledSends', () => {
  it('reads a send as a card while queued or once handed off, else as recorded under its id', () => {
    const handOff = submission('hand-off', 'was-queued')
    const sent = submission('sent')
    const { cards, recorded } = structuredAgentSessionSettledSends([handOff, sent], ['on-queue'])
    expect([...cards]).toEqual(['on-queue', 'was-queued'])
    expect(recorded.get('sent')).toBe(sent)
    expect(recorded.get('hand-off')).toBe(handOff)
    expect(recorded.has('on-queue')).toBe(false)
  })
})
