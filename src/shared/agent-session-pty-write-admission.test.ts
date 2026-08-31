import { describe, expect, it } from 'vitest'
import {
  AgentSessionPtyWriteRefusedError,
  describeAgentSessionPtyWriteRefusal,
  evaluateAgentSessionPtyWriteAdmission,
  isAgentSessionPtyWriteRefusedError,
  reevaluateAgentSessionPtyWriteAdmission
} from './agent-session-pty-write-admission'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from './agent-session-record.test-fixture'
import type { AgentSessionLease } from './agent-session-record'
import { AGENT_SESSION_RPC_ERROR_CODES } from './agent-session-host-authority'

function bindingFor(lease: AgentSessionLease) {
  return { sessionId: lease.sessionId, record: agentSessionRecordFixture(lease) }
}

describe('exemptions', () => {
  it('admits a PTY with no binding, which is every ordinary shell and legacy agent terminal', () => {
    const admission = evaluateAgentSessionPtyWriteAdmission(null)
    expect(admission).toEqual({ admitted: true, sessionId: null, runtimeFence: null })
  })

  it('admits a proven-live TUI owner', () => {
    const lease = agentSessionLeaseFixture()
    expect(evaluateAgentSessionPtyWriteAdmission(bindingFor(lease))).toEqual({
      admitted: true,
      sessionId: lease.sessionId,
      runtimeFence: lease.runtimeFence
    })
  })
})

describe('refusal matrix', () => {
  const cases: { name: string; lease: Partial<AgentSessionLease>; code: string }[] = [
    {
      name: 'native chat owns the session',
      lease: { runtimeKind: 'native' },
      code: 'agent_session_conflict'
    },
    {
      name: 'a handoff is preparing',
      lease: { handoffStage: 'preparing' },
      code: 'agent_session_conflict'
    },
    {
      name: 'the old owner stopped mid-handoff',
      lease: { handoffStage: 'old-owner-stopped' },
      code: 'agent_session_conflict'
    },
    {
      name: 'the new owner has not proved itself',
      lease: { handoffStage: 'new-owner-proving' },
      code: 'agent_session_conflict'
    },
    {
      name: 'two claims collided',
      lease: { claimStatus: 'conflicted' },
      code: 'agent_session_conflict'
    },
    {
      name: 'the lease is unreconciled after a host restart',
      lease: { unreconciled: true },
      code: 'execution_owner_reconciling'
    },
    {
      name: 'recovery is running',
      lease: { handoffStage: 'recovering' },
      code: 'execution_owner_reconciling'
    },
    {
      name: 'a human must finish recovery',
      lease: { handoffStage: 'manual-recovery' },
      code: 'execution_owner_reconciling'
    },
    {
      name: 'the claim is reserved but no process exists yet',
      lease: { claimStatus: 'reserved', ownerProcess: null },
      code: 'agent_session_ownership_unknown'
    },
    {
      name: 'the owner released the session',
      lease: { claimStatus: 'released' },
      code: 'agent_session_ownership_unknown'
    }
  ]

  for (const testCase of cases) {
    it(`refuses when ${testCase.name}`, () => {
      const lease = agentSessionLeaseFixture(testCase.lease)
      const admission = evaluateAgentSessionPtyWriteAdmission(bindingFor(lease))
      expect(admission.admitted).toBe(false)
      if (admission.admitted) {
        return
      }
      expect(admission.refusal.code).toBe(testCase.code)
      expect(admission.refusal.sessionId).toBe(lease.sessionId)
      expect(admission.refusal.ownerRuntimeKind).toBe(lease.runtimeKind)
      expect(admission.refusal.handoffStage).toBe(lease.handoffStage)
      expect(admission.refusal.runtimeFence).toBe(lease.runtimeFence)
    })
  }

  it('distinguishes a reconciling window from a session another runtime owns', () => {
    // Phase-2 clients render "recovering, retry shortly" only when these two do not collapse.
    const reconciling = evaluateAgentSessionPtyWriteAdmission(
      bindingFor(agentSessionLeaseFixture({ unreconciled: true }))
    )
    const owned = evaluateAgentSessionPtyWriteAdmission(
      bindingFor(agentSessionLeaseFixture({ runtimeKind: 'native' }))
    )
    expect(reconciling.admitted).toBe(false)
    expect(owned.admitted).toBe(false)
    if (reconciling.admitted || owned.admitted) {
      return
    }
    expect(reconciling.refusal.code).not.toBe(owned.refusal.code)
  })

  it('fails closed when a bound PTY has no readable record', () => {
    const admission = evaluateAgentSessionPtyWriteAdmission({
      sessionId: 'session-alpha-1',
      record: null
    })
    expect(admission.admitted).toBe(false)
    if (admission.admitted) {
      return
    }
    expect(admission.refusal.code).toBe('execution_owner_reconciling')
    expect(admission.refusal.ownerRuntimeKind).toBeNull()
  })

  it('fails closed when the record answers for a different session', () => {
    const admission = evaluateAgentSessionPtyWriteAdmission({
      sessionId: 'session-beta-2',
      record: agentSessionRecordFixture()
    })
    expect(admission.admitted).toBe(false)
    if (admission.admitted) {
      return
    }
    expect(admission.refusal.code).toBe('agent_session_ownership_unknown')
    expect(admission.refusal.sessionId).toBe('session-beta-2')
  })

  it('only emits codes old clients already decode', () => {
    const emitted = new Set(
      cases.map((testCase) => {
        const admission = evaluateAgentSessionPtyWriteAdmission(
          bindingFor(agentSessionLeaseFixture(testCase.lease))
        )
        return admission.admitted ? 'admitted' : admission.refusal.code
      })
    )
    for (const code of emitted) {
      expect(AGENT_SESSION_RPC_ERROR_CODES).toContain(code)
    }
  })
})

describe('in-flight fence race', () => {
  const admittedLease = agentSessionLeaseFixture()
  const admitted = { sessionId: admittedLease.sessionId, runtimeFence: admittedLease.runtimeFence }

  it('lets the rest of a write land while the same fence still holds', () => {
    const next = reevaluateAgentSessionPtyWriteAdmission({
      admitted,
      binding: bindingFor(admittedLease)
    })
    expect(next.admitted).toBe(true)
  })

  it('refuses the rest of a write once the fence advanced under it', () => {
    // A handoff completed between two chunks: the new owner's lease would otherwise admit them.
    const moved = agentSessionLeaseFixture({ runtimeFence: admittedLease.runtimeFence + 1 })
    const next = reevaluateAgentSessionPtyWriteAdmission({ admitted, binding: bindingFor(moved) })
    expect(next.admitted).toBe(false)
    if (next.admitted) {
      return
    }
    expect(next.refusal.code).toBe('agent_session_checkpoint_stale')
    expect(next.refusal.runtimeFence).toBe(moved.runtimeFence)
  })

  it('refuses the rest of a write when the PTY was rebound to another session', () => {
    const other = agentSessionLeaseFixture({ sessionId: 'session-beta-2' })
    const next = reevaluateAgentSessionPtyWriteAdmission({ admitted, binding: bindingFor(other) })
    expect(next.admitted).toBe(false)
  })

  it('refuses the rest of a write when the binding disappeared mid-flight', () => {
    const next = reevaluateAgentSessionPtyWriteAdmission({ admitted, binding: null })
    expect(next.admitted).toBe(false)
  })

  it('refuses the rest of a write when the lease stopped admitting a writer', () => {
    const next = reevaluateAgentSessionPtyWriteAdmission({
      admitted,
      binding: bindingFor(agentSessionLeaseFixture({ handoffStage: 'preparing' }))
    })
    expect(next.admitted).toBe(false)
    if (next.admitted) {
      return
    }
    expect(next.refusal.code).toBe('agent_session_conflict')
  })

  it('judges a write admitted while unbound on whatever binding appeared', () => {
    const next = reevaluateAgentSessionPtyWriteAdmission({
      admitted: { sessionId: null, runtimeFence: null },
      binding: bindingFor(agentSessionLeaseFixture({ runtimeKind: 'native' }))
    })
    expect(next.admitted).toBe(false)
  })
})

describe('typed error', () => {
  it('carries the refusal and reports its code as the message', () => {
    const admission = evaluateAgentSessionPtyWriteAdmission(
      bindingFor(agentSessionLeaseFixture({ runtimeKind: 'native' }))
    )
    if (admission.admitted) {
      throw new Error('expected a refusal')
    }
    const error = new AgentSessionPtyWriteRefusedError(admission.refusal)
    expect(isAgentSessionPtyWriteRefusedError(error)).toBe(true)
    expect(isAgentSessionPtyWriteRefusedError(new Error('agent_session_conflict'))).toBe(false)
    expect(error.message).toBe('agent_session_conflict')
    expect(error.refusal).toEqual(admission.refusal)
  })

  it('describes who holds the session and what stage it is in', () => {
    const admission = evaluateAgentSessionPtyWriteAdmission(
      bindingFor(agentSessionLeaseFixture({ runtimeKind: 'native', handoffStage: 'preparing' }))
    )
    if (admission.admitted) {
      throw new Error('expected a refusal')
    }
    const described = describeAgentSessionPtyWriteRefusal(admission.refusal)
    expect(described).toContain('session-alpha-1')
    expect(described).toContain('native chat')
    expect(described).toContain('pid 4242')
    expect(described).toContain('preparing')
  })
})
