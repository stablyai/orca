import { describe, expect, it } from 'vitest'
import type { AgentSessionOperationDecision } from './agent-session-operation-ledger'
import { agentSessionLeaseFixture } from './agent-session-record.test-fixture'
import {
  admitAgentSessionMutation,
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from './agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from './agent-session-wire'

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

  it('separates one payload from another and one method from another', () => {
    const send = computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: 'session-1',
      fields: { text: 'hi' }
    })
    expect(
      computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { text: 'hi there' }
      })
    ).not.toBe(send)
    expect(
      computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: 'session-1',
        fields: { text: 'hi' }
      })
    ).not.toBe(send)
  })
})

describe('agentSessionFingerprintConflict', () => {
  it('refuses a payload that does not match what the client declared', () => {
    const conflict = agentSessionFingerprintConflict(envelope(), 'a'.repeat(64))
    expect(conflict?.code).toBe('agent_session_operation_conflict')
  })

  it('passes a matching declaration', () => {
    expect(agentSessionFingerprintConflict(envelope(), 'f'.repeat(64))).toBeNull()
  })
})

describe('admitAgentSessionMutation', () => {
  const base = { envelope: envelope(), hostFingerprint: 'f'.repeat(64), lease: LEASE }

  it('admits a first-time operation under a live lease at the expected fence', () => {
    expect(admitAgentSessionMutation({ ...base, ledger: ADMIT('f'.repeat(64)) }).decision).toBe(
      'admit'
    )
  })

  it('replays a recorded operation without re-checking the fence', () => {
    const admission = admitAgentSessionMutation({
      ...base,
      envelope: envelope({ expectedRuntimeFence: 1 }),
      ledger: { decision: 'replay', row: row('f'.repeat(64)) }
    })
    expect(admission.decision).toBe('replay')
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

  it('refuses a writer while the lease is unreconciled', () => {
    const admission = admitAgentSessionMutation({
      ...base,
      lease: { ...LEASE, unreconciled: true },
      ledger: ADMIT('f'.repeat(64))
    })
    expect(admission).toMatchObject({
      decision: 'refused',
      refusal: { code: 'execution_owner_reconciling' }
    })
  })

  it('refuses a writer while the chat is still starting', () => {
    const admission = admitAgentSessionMutation({
      ...base,
      lease: { ...LEASE, handoffStage: 'new-owner-proving' },
      ledger: ADMIT('f'.repeat(64))
    })
    expect(admission).toMatchObject({
      decision: 'refused',
      refusal: { code: 'agent_session_conflict', message: 'The chat is still starting.' }
    })
  })

  it('names recovery rather than a handoff when a restart left the owner unproven', () => {
    const admission = admitAgentSessionMutation({
      ...base,
      lease: { ...LEASE, handoffStage: 'recovering' },
      ledger: ADMIT('f'.repeat(64))
    })
    expect(admission).toMatchObject({
      decision: 'refused',
      refusal: {
        code: 'agent_session_conflict',
        message:
          "Orca has not yet confirmed that this chat's previous agent process stopped. Reopen the chat to check again."
      }
    })
  })

  it('surfaces a ledger refusal verbatim', () => {
    const admission = admitAgentSessionMutation({
      ...base,
      ledger: {
        decision: 'refused',
        code: 'agent_session_operation_expired',
        cause: 'operationExpired'
      }
    })
    expect(admission).toMatchObject({
      decision: 'refused',
      refusal: { code: 'agent_session_operation_expired', cause: 'operationExpired' }
    })
  })
})
