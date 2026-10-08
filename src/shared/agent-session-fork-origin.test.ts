import { describe, expect, it } from 'vitest'
import { isPersistedAgentSessionRecord } from './agent-session-record'
import { encodeAgentSessionRecord } from './agent-session-record-stored-form'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'

/** A record as the store writes it. */
const stored = () => encodeAgentSessionRecord(agentSessionRecordFixture())

const forkedFrom = {
  sessionId: 'codex_parent_chat',
  itemId: 'codex:thread-parent:turn-1:1',
  providerSessionId: 'thread-parent',
  forkPoint: 'turn-1'
}

describe('a stored record’s fork origin', () => {
  it('loads with a complete origin', () => {
    expect(isPersistedAgentSessionRecord({ ...stored(), forkedFrom })).toBe(true)
  })

  it.each([
    ['is missing its cut', { ...forkedFrom, forkPoint: undefined }],
    ['names no parent conversation', { ...forkedFrom, providerSessionId: '' }],
    ['is not an object', 'codex_parent_chat']
  ])('refuses a record whose origin %s, which a Codex fork would start from', (_, origin) => {
    const record = { ...stored(), forkedFrom: origin }

    expect(isPersistedAgentSessionRecord(record)).toBe(false)
  })
})
