import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import {
  pendingQueueSendsOnTheirWay,
  pendingSendsOutsideQueuedCards
} from './structured-agent-session-sending-queued-cards'

function submission(clientMessageId: string, queuedMessageId?: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    ...(queuedMessageId !== undefined ? { queuedMessageId } : {})
  }
}

describe('queue sends on their way', () => {
  it('a mid-turn queue send on its way is no bubble; a plain or recorded one is, until its row', () => {
    const entry = (
      clientMessageId: string,
      overrides: Partial<StructuredAgentSessionPendingSend> = {}
    ): StructuredAgentSessionPendingSend => ({
      clientMessageId,
      sessionId: 'session-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
      previewUris: [],
      queuedAt: 1,
      phase: 'sending',
      issued: true,
      ...overrides
    })
    const ids = (entries: readonly StructuredAgentSessionPendingSend[]): string[] =>
      entries.map((candidate) => candidate.clientMessageId)
    const sends = [
      entry('queued', { delivery: 'queue-if-active' }),
      entry('plain'),
      entry('recorded', { phase: 'recorded' })
    ]
    // Pending queued sends use cards while working; plain/recorded sends remain bubbles until host ownership appears.
    expect(ids(pendingSendsOutsideQueuedCards(sends, [], true))).toEqual(['plain', 'recorded'])
    expect(ids(pendingSendsOutsideQueuedCards(sends, [], false))).toEqual([
      'queued',
      'plain',
      'recorded'
    ])
    expect(ids(pendingSendsOutsideQueuedCards(sends, ['plain'], false))).toEqual([
      'queued',
      'recorded'
    ])
  })
  it('a sending card ends once the host records the send or hands its card off', () => {
    const entry: StructuredAgentSessionPendingSend = {
      clientMessageId: 'a',
      sessionId: 'session-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'a' }] },
      previewUris: [],
      queuedAt: 1,
      phase: 'sending',
      issued: true,
      delivery: 'queue-if-active'
    }
    const onItsWay = (submissions: AgentJournalSubmission[]) =>
      pendingQueueSendsOnTheirWay([entry], [], true, submissions).map(
        (candidate) => candidate.clientMessageId
      )
    expect(onItsWay([])).toEqual(['a'])
    expect(onItsWay([submission('a')])).toEqual([])
    expect(onItsWay([submission('a-hand-off', 'a')])).toEqual([])
    expect(pendingQueueSendsOnTheirWay([entry], ['a'], true, [])).toEqual([])
    expect(pendingQueueSendsOnTheirWay([entry], [], false, [])).toEqual([])
    expect(pendingQueueSendsOnTheirWay([{ ...entry, phase: 'recorded' }], [], true, [])).toEqual([])
  })
})
