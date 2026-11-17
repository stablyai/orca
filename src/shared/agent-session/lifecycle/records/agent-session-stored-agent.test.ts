import { describe, expect, it } from 'vitest'
import { isPersistedAgentSessionRecord, type AgentSessionRecord } from '../agent-session-record'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'
import { encodeAgentSessionRecord } from './agent-session-record-stored-form'

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
  it('sets aside a record whose handles name another agent, or mix transports', () => {
    const record = grokRecord()
    const [link] = record.providerHandleChain
    const foreign = { ...link!, handle: { ...link!.handle, agent: 'codex' } }
    const fork = {
      ...link!,
      linkId: 'second',
      origin: 'forked' as const,
      forkedFromKey: 'acp/grok:"grok-session-1"',
      handle: { ...link!.handle, nativeId: 'grok-session-2' }
    }
    const released = { ...record, lease: { ...record.lease, claimStatus: 'released' as const } }
    expect(
      isPersistedAgentSessionRecord(
        encodeAgentSessionRecord({ ...released, providerHandleChain: [link!, fork] })
      )
    ).toBe(true)
    const mixed = { ...fork, handle: { ...fork.handle, transport: 'other' } }
    for (const chain of [[foreign], [link!, mixed]]) {
      expect(
        isPersistedAgentSessionRecord(
          encodeAgentSessionRecord({ ...released, providerHandleChain: chain })
        )
      ).toBe(false)
    }
  })
})
