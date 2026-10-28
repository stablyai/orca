import { describe, expect, it } from 'vitest'
import { isPersistedAgentSessionRecord, type AgentSessionRecord } from '../../agent-session-record'
import { agentSessionRecordFixture } from '../../agent-session-record.test-fixture'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from '../../agent-session-record-stored-form'

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

  // Check transport drivability at start (structured-agent-session-drivability.test.ts), so definition changes never hide stored chats.
  it("reads a record whose handles are in a transport other than the agent's current one", () => {
    expect(isPersistedAgentSessionRecord(encodeAgentSessionRecord(grokRecord('other')))).toBe(true)
  })

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

  it('keeps reading Claude and Codex records exactly as before', () => {
    const claude = agentSessionRecordFixture()
    const codex = {
      ...claude,
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/home/user/.codex' },
      providerHandleChain: claude.providerHandleChain.map((link) => ({
        ...link,
        handle: { transport: 'codex-app-server', agent: 'codex', nativeId: 'codex-thread-1' }
      }))
    }
    const storedClaude = encodeAgentSessionRecord(claude)
    const storedCodex = encodeAgentSessionRecord(codex)
    expect(isPersistedAgentSessionRecord(storedClaude)).toBe(true)
    expect(isPersistedAgentSessionRecord(storedCodex)).toBe(true)
    expect(JSON.stringify(storedClaude.providerHandleChain[0]?.handle)).toBe(
      '{"provider":"claude","sessionId":"provider-session-alpha-1","leafUuid":null}'
    )
    expect(JSON.stringify(storedCodex.providerHandleChain[0]?.handle)).toBe(
      '{"provider":"codex","threadId":"codex-thread-1"}'
    )
    expect(decodePersistedAgentSessionRecord(storedClaude).record).toEqual(claude)
    expect(decodePersistedAgentSessionRecord(storedCodex).record).toEqual(codex)
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
