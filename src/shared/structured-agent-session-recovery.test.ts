import { describe, expect, it } from 'vitest'
import {
  createStructuredAgentSessionOutboxEntry,
  parseStructuredAgentSessionOutboxEntry,
  structuredAgentSessionSendRequest
} from './structured-agent-session-outbox'
import {
  advanceStructuredAgentSessionRecovery,
  resumeStructuredAgentSessionRecovery
} from './structured-agent-session-recovery'

const legacy = {
  ...createStructuredAgentSessionOutboxEntry({
    clientMessageId: 'op',
    sessionId: 'session',
    text: 'draft',
    attachments: [{ path: 'image', previewUri: 'preview' }],
    queuedAt: 1
  }),
  state: 'unconfirmed' as const
}

describe('structured session recovery persistence', () => {
  it('reads legacy data without losing payloads and round-trips a parked operation', () => {
    expect(parseStructuredAgentSessionOutboxEntry(legacy, 'session')).toEqual(legacy)
    let current = legacy
    let now = 0
    for (let i = 0; i < 8; i++) {
      current = advanceStructuredAgentSessionRecovery(current, now) as typeof legacy
      now = current.recovery!.nextProbeAt!
      current = { ...advanceStructuredAgentSessionRecovery(current, now), state: 'unconfirmed' }
    }
    expect(now).toBe(79000)
    current = advanceStructuredAgentSessionRecovery(current, now) as typeof legacy
    const restored = parseStructuredAgentSessionOutboxEntry(
      JSON.parse(JSON.stringify(current)),
      'session'
    )!
    expect(restored.recovery?.parkedReason).toBe('budget-exhausted')
    expect(advanceStructuredAgentSessionRecovery(restored, now + 100000)).toBe(restored)
    expect(
      structuredAgentSessionSendRequest(resumeStructuredAgentSessionRecovery(restored), 1)
    ).toEqual(structuredAgentSessionSendRequest(legacy, 1))
  })

  it.each([
    null,
    {},
    { attempts: -1 },
    { attempts: 99 },
    { attempts: 1.5 },
    { attempts: 0, nextProbeAt: Infinity, parkedReason: null }
  ])('retains malformed-budget messages while parking background work: %j', (recovery) => {
    const entry = parseStructuredAgentSessionOutboxEntry({ ...legacy, recovery }, 'session')!
    expect(entry.body).toEqual(legacy.body)
    expect(entry.previewUris).toEqual(legacy.previewUris)
    expect(entry.recovery?.parkedReason).toBe('budget-exhausted')
    expect(advanceStructuredAgentSessionRecovery(entry, 100000)).toBe(entry)
  })
})
