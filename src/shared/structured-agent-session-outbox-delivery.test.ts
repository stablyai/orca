// The entry keeps only what its first attempt sent; each request decides the wire field from that
// and the host's capability. Nothing ever waits on the capability.

import { describe, expect, it } from 'vitest'
import {
  createStructuredAgentSessionOutboxEntry,
  parseStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'
import {
  structuredAgentSessionEntryAttempt,
  type StructuredAgentSessionQueueCapability
} from './structured-agent-session-outbox-delivery'

function entry(overrides: Partial<StructuredAgentSessionOutboxEntry> = {}) {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'op-1',
      sessionId: 'session-1',
      text: 'hello',
      attachments: [],
      queuedAt: 1
    }),
    ...overrides
  }
}

function host(capability: StructuredAgentSessionQueueCapability, enabled = true) {
  return { capability, enabled }
}

describe('a first attempt', () => {
  it('asks to queue only of a host known to queue, with the setting on, for plain text', () => {
    const queued = structuredAgentSessionEntryAttempt(entry(), host('supported'))
    expect(queued.wire.sentDelivery).toBe('queue-if-active')
    expect(queued.stored.sentDelivery).toBe('queue-if-active')
    for (const off of [host('unknown'), host('unsupported'), host('supported', false)]) {
      const plain = structuredAgentSessionEntryAttempt(entry(), off)
      expect(plain.wire.sentDelivery).toBeNull()
      expect(plain.stored.sentDelivery).toBeNull()
    }
    const image = {
      ...entry(),
      body: {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'image-ref' as const, path: '/tmp/a.png' }]
      }
    }
    expect(
      structuredAgentSessionEntryAttempt(image, host('supported')).wire.sentDelivery
    ).toBeNull()
    const launch = entry({ source: 'launch' })
    expect(
      structuredAgentSessionEntryAttempt(launch, host('supported')).wire.sentDelivery
    ).toBeNull()
  })

  it('never queues an async question answer: it steers into the running turn', () => {
    const answer = entry({ origin: { kind: 'async-answer', edits: { k: 'Blue' } } })
    const attempt = structuredAgentSessionEntryAttempt(answer, host('supported'))
    expect(attempt.wire.sentDelivery).toBeNull()
    expect(attempt.stored.sentDelivery).toBeNull()
  })
})

describe('a replay of an attempted id', () => {
  const sentQueued = entry({ lastAttemptAt: 5, sentDelivery: 'queue-if-active' })
  const sentPlain = entry({ lastAttemptAt: 5, sentDelivery: null })

  it('sends exactly what it first sent, whatever the capability reads or the setting says', () => {
    for (const current of [host('unknown'), host('supported', false), host('supported')]) {
      expect(structuredAgentSessionEntryAttempt(sentQueued, current).wire.sentDelivery).toBe(
        'queue-if-active'
      )
      expect(structuredAgentSessionEntryAttempt(sentPlain, current).wire.sentDelivery).toBeNull()
      expect(structuredAgentSessionEntryAttempt(sentQueued, current).stored).toBe(sentQueued)
    }
  })

  it('drops the field for a host known not to read it, and keeps what was sent', () => {
    const attempt = structuredAgentSessionEntryAttempt(sentQueued, host('unsupported'))
    expect(attempt.wire.sentDelivery).toBeNull()
    expect(attempt.wire.clientMessageId).toBe('op-1')
    expect(attempt.stored).toBe(sentQueued)
  })

  it('stores no intent: a stale `delivery` key is dropped on read, and a main entry sends plain', () => {
    const read = parseStructuredAgentSessionOutboxEntry(
      { ...entry({ lastAttemptAt: 5 }), delivery: 'queue-if-active' },
      'session-1'
    )
    expect(read !== null && 'delivery' in read).toBe(false)
    expect(
      read && structuredAgentSessionEntryAttempt(read, host('supported')).wire.sentDelivery
    ).toBe(null)
  })
})
