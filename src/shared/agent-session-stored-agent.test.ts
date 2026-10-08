import { describe, expect, it } from 'vitest'
import { isPersistedAgentSessionRecord, type AgentSessionRecord } from './agent-session-record'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from './agent-session-record-stored-form'

function grokRecord(transport = 'acp'): AgentSessionRecord {
  const record = agentSessionRecordFixture()
  return {
    ...record,
    provider: 'grok',
    providerHandleChain: record.providerHandleChain.map((link) => ({
      ...link,
      handle: { transport, agent: 'grok', nativeId: 'grok-session-1', resumeCursor: '{"cwd":"/w"}' }
    })),
    accountHome: { variable: 'GROK_HOME', path: '/home/user/.grok' }
  }
}

describe('provider-independent stored records', () => {
  it('reads and decodes a well-formed record', () => {
    const stored = encodeAgentSessionRecord(grokRecord())
    expect(isPersistedAgentSessionRecord(stored)).toBe(true)
    if (!isPersistedAgentSessionRecord(stored)) {
      return
    }
    expect(decodePersistedAgentSessionRecord(stored).record).toEqual(grokRecord())
  })

  it('reads a saved record without a provider registration', () => {
    expect(isPersistedAgentSessionRecord(encodeAgentSessionRecord(grokRecord()))).toBe(true)
  })

  it.each(['', '1grok', 'gro k', 'grok/', 'g'.repeat(65)])(
    'quarantines a malformed provider id %j even without a handle',
    (provider) => {
      const record = grokRecord()
      expect(
        isPersistedAgentSessionRecord({
          ...encodeAgentSessionRecord(record),
          provider,
          providerHandleChain: [],
          lease: { ...record.lease, claimStatus: 'released' }
        })
      ).toBe(false)
    }
  )

  // Whether this build can drive the chain's transport is decided when its agent would start
  // (structured-agent-session-drivability.test.ts), so a definition change never hides a chat.
  it("reads a record whose handles are in a transport other than the agent's current one", () => {
    expect(isPersistedAgentSessionRecord(encodeAgentSessionRecord(grokRecord('other')))).toBe(true)
  })

  it('sets aside a record whose handles name another agent, or mix transports', () => {
    const record = grokRecord()
    const [link] = record.providerHandleChain
    const foreign = { ...link!, handle: { ...link!.handle, agent: 'codex' } }
    const mixed = { ...link!, linkId: 'second', handle: { ...link!.handle, transport: 'other' } }
    for (const chain of [[foreign], [link!, mixed]]) {
      expect(
        isPersistedAgentSessionRecord(
          encodeAgentSessionRecord({ ...record, providerHandleChain: chain })
        )
      ).toBe(false)
    }
  })

  it('keeps reading Claude and Codex records exactly as before', () => {
    const stored = encodeAgentSessionRecord(agentSessionRecordFixture())
    expect(isPersistedAgentSessionRecord(stored)).toBe(true)
    expect(JSON.stringify(stored.providerHandleChain[0]?.handle)).toBe(
      '{"provider":"claude","sessionId":"provider-session-alpha-1","leafUuid":null}'
    )
  })

  it('refuses a Claude record whose handles another agent owns', () => {
    const record = agentSessionRecordFixture()
    expect(
      isPersistedAgentSessionRecord(
        encodeAgentSessionRecord({ ...record, provider: 'codex', accountHome: record.accountHome })
      )
    ).toBe(false)
  })
})
