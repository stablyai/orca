// `delivery: 'queue-if-active'` on a send: recorded as the entry's `sentDelivery` by its first
// attempt, persisted, replayed identically, and absent — key and all — from any send an incapable
// host could see (its strict schema refuses unknown keys).

import { describe, expect, it } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'
import {
  createStructuredAgentSessionOutboxEntry,
  parseStructuredAgentSessionOutboxEntry,
  stageStructuredAgentSessionOutboxEntryForSend,
  structuredAgentSessionSendMutation,
  structuredAgentSessionSendRequest,
  type StructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxState
} from './structured-agent-session-outbox'
import { admitStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-admission'
import { structuredAgentSessionEntryAttempt } from './structured-agent-session-outbox-delivery'
import { disposeStructuredAgentSessionSendResult } from './structured-agent-session-send-disposition'
import { withdrawUnsentStructuredAgentSessionOutboxEntries } from './structured-agent-session-outbox-stop-withdrawal'

function entry(sentDelivery?: 'queue-if-active') {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'client-1',
      sessionId: 'session-1',
      text: 'hello',
      attachments: [],
      queuedAt: 1
    }),
    ...(sentDelivery ? { sentDelivery } : {})
  }
}

describe('outbox queue delivery', () => {
  it('sends `delivery` and digests it into the operation fingerprint, exactly as the host does', () => {
    const mutation = structuredAgentSessionSendMutation(entry('queue-if-active'), 3)
    expect(mutation.delivery).toBe('queue-if-active')
    expect(mutation.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: mutation.body, delivery: 'queue-if-active' }
      })
    )
  })

  it('a plain entry keeps exactly the request an older host has always seen', () => {
    const request = structuredAgentSessionSendRequest(entry(), 3)
    expect('delivery' in request).toBe(false)
    const mutation = structuredAgentSessionSendMutation(entry(), 3)
    expect(mutation.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: mutation.body }
      })
    )
  })

  it('persists through a storage round-trip so a retry replays the same operation', () => {
    const parsed = parseStructuredAgentSessionOutboxEntry(
      JSON.parse(JSON.stringify(entry('queue-if-active'))),
      'session-1'
    )
    expect(parsed?.sentDelivery).toBe('queue-if-active')
    const plain = parseStructuredAgentSessionOutboxEntry(
      JSON.parse(JSON.stringify(entry())),
      'session-1'
    )
    expect(plain !== null && 'sentDelivery' in plain).toBe(false)
    const foreign = parseStructuredAgentSessionOutboxEntry(
      { ...JSON.parse(JSON.stringify(entry())), sentDelivery: 'something-newer' },
      'session-1'
    )
    expect(foreign !== null && 'sentDelivery' in foreign).toBe(false)
  })

  it('Stop keeps every queue send that has gone out, in any state, and marks it for Retry', () => {
    // An attempted queue send may already be a host-held draft: withdrawing it locally too would
    // put the same text in the composer AND on a card. Read from what went on the wire.
    const at = (
      id: string,
      state: StructuredAgentSessionOutboxState,
      sent?: 'queue-if-active' | null
    ) => ({
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: id,
        sessionId: 'session-1',
        text: `text of ${id}`,
        attachments: [],
        queuedAt: 1
      }),
      ...(sent !== undefined ? { lastAttemptAt: 2, sentDelivery: sent } : {}),
      state
    })
    const next = withdrawUnsentStructuredAgentSessionOutboxEntries(
      [
        at('never-left', 'queued'),
        // No in-flight id: a `pending` answer freed single-flight before its journal row landed.
        at('in-flight', 'dispatching', 'queue-if-active'),
        at('in-doubt', 'unconfirmed', 'queue-if-active'),
        // Probed back to queued after a lost answer: still out there, not unsent.
        at('probed', 'queued', 'queue-if-active'),
        at('sent-plain', 'dispatching', null)
      ],
      [],
      null
    )
    // Its state is left to its answer: only the mark holds it back.
    expect(next.map((entry) => [entry.clientMessageId, entry.state, entry.outlivedStop])).toEqual([
      ['in-flight', 'dispatching', true],
      ['in-doubt', 'unconfirmed', true],
      ['probed', 'queued', true]
    ])
    // The drain never admits the marked one it would otherwise send.
    expect(admitStructuredAgentSessionOutboxEntry(next.slice(2))).toEqual({
      state: 'blocked',
      entry: next[2]
    })
  })

  it('Stop during a first queue attempt, then a settled refusal: rotated and rejected, as without it', () => {
    const operations = ['rotated-1', 'rotated-2']
    const attempt = structuredAgentSessionEntryAttempt(entry(), {
      capability: 'supported',
      enabled: true
    })
    const staged = stageStructuredAgentSessionOutboxEntryForSend(attempt.stored, 10)
    const refusal = {
      ok: false as const,
      refusal: {
        code: 'agent_session_operation_invalid' as const,
        message: 'The message queue is full.'
      }
    }
    const answer = (entries: StructuredAgentSessionOutboxEntry[]) =>
      disposeStructuredAgentSessionSendResult({
        entries,
        entry: attempt.wire,
        result: refusal,
        createOperationId: () => operations.shift() ?? 'spent'
      })
    const stopped = withdrawUnsentStructuredAgentSessionOutboxEntries([staged], [], 'client-1')
    const withStop = answer(stopped)
    const withoutStop = answer([staged])
    expect(
      withStop.entries.map((candidate) => [candidate.clientMessageId, candidate.state])
    ).toEqual([['rotated-1', 'rejected']])
    expect(
      withoutStop.entries.map((candidate) => [candidate.clientMessageId, candidate.state])
    ).toEqual([['rotated-2', 'rejected']])
  })
})
