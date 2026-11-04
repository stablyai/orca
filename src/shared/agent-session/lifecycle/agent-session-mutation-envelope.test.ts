import { describe, expect, it } from 'vitest'
import type { AgentSessionOperationDecision } from './agent-session-operation-ledger'
import { agentSessionLeaseFixture } from './agent-session-record.test-fixture'
import {
  admitAgentSessionMutation,
  computeAgentSessionPayloadFingerprint
} from './agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../agent-session-wire'

const LEASE = agentSessionLeaseFixture({
  sessionId: 'session-1',
  runtimeKind: 'native',
  runtimeFence: 4
})

function envelope(overrides: Partial<AgentSessionMutationEnvelope> = {}) {
  return {
    sessionId: 'session-1',
    clientOperationId: 'op-1',
    expectedRuntimeFence: 4,
    payloadFingerprint: 'f'.repeat(64),
    ...overrides
  }
}

function row(fingerprint: string) {
  return {
    callerKey: 'caller-1',
    operationId: 'op-1',
    fingerprint,
    operationTimestamp: 1_000,
    recordedAt: 1_000,
    expiresAt: 100_000,
    outcome: { status: 'pending' as const }
  }
}

const ADMIT = (fingerprint: string): AgentSessionOperationDecision => ({
  decision: 'admit',
  row: row(fingerprint)
})

describe('computeAgentSessionPayloadFingerprint', () => {
  it('is stable across key order at every depth', () => {
    const a = computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: 'session-1',
      fields: { body: { kind: 'message', blocks: [{ type: 'text', text: 'hi' }] }, extra: 1 }
    })
    const b = computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: 'session-1',
      fields: { extra: 1, body: { blocks: [{ text: 'hi', type: 'text' }], kind: 'message' } }
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('admitAgentSessionMutation', () => {
  const base = { envelope: envelope(), hostFingerprint: 'f'.repeat(64), lease: LEASE }

  it('replays a recorded outcome even while the lease is unreconciled', () => {
    const recorded = {
      ...row('f'.repeat(64)),
      outcome: { status: 'succeeded' as const, sessionId: 'created-session' }
    }
    const admission = admitAgentSessionMutation({
      ...base,
      envelope: envelope({ expectedRuntimeFence: 1 }),
      lease: { ...LEASE, unreconciled: true },
      ledger: { decision: 'replay', row: recorded }
    })
    expect(admission).toEqual({ decision: 'replay', row: recorded })
  })

  it('admits a writer whatever fence the client last saw', () => {
    for (const expectedRuntimeFence of [3, 5, null]) {
      const admission = admitAgentSessionMutation({
        ...base,
        envelope: envelope({ expectedRuntimeFence }),
        ledger: ADMIT('f'.repeat(64))
      })
      expect(admission, String(expectedRuntimeFence)).toMatchObject({ decision: 'admit' })
    }
  })
})
