import { describe, expect, it } from 'vitest'
import {
  leaseCarriesLegacyHandoffValues,
  normalizeLegacyHandoffLease,
  type PersistedAgentSessionLease
} from './agent-session-legacy-handoff-lease'
import type { AgentSessionClaimStatus } from './agent-session-record'
import { agentSessionLeaseFixture } from './agent-session-record.test-fixture'

const CLAIMS: AgentSessionClaimStatus[] = ['reserved', 'live', 'conflicted', 'released']

function persisted(overrides: Partial<PersistedAgentSessionLease>): PersistedAgentSessionLease {
  return { ...agentSessionLeaseFixture(), ...overrides }
}

describe('normalizing a lease the removed terminal handoff wrote', () => {
  it.each(['preparing', 'old-owner-stopped', 'manual-recovery'] as const)(
    'maps the %s stage to recovering and keeps its operation id',
    (handoffStage) => {
      const lease = persisted({ handoffStage, handoffOperationId: 'op-handoff' })
      expect(normalizeLegacyHandoffLease(lease)).toEqual({
        ...lease,
        handoffStage: 'recovering'
      })
      expect(leaseCarriesLegacyHandoffValues(lease)).toBe(true)
    }
  )

  it.each(CLAIMS)(
    'turns a recorded terminal owner (%s) into a conflicted native claim',
    (claim) => {
      const lease = persisted({ runtimeKind: 'tui', claimStatus: claim })
      expect(normalizeLegacyHandoffLease(lease)).toEqual({
        ...lease,
        runtimeKind: 'native',
        claimStatus: 'conflicted'
      })
    }
  )

  it.each(CLAIMS)('changes only the kind of a terminal lease naming no process (%s)', (claim) => {
    const lease = persisted({ runtimeKind: 'tui', claimStatus: claim, ownerProcess: null })
    expect(normalizeLegacyHandoffLease(lease)).toEqual({ ...lease, runtimeKind: 'native' })
    expect(leaseCarriesLegacyHandoffValues(lease)).toBe(true)
  })

  it('maps a terminal owner mid return trip on both fields', () => {
    const lease = persisted({ runtimeKind: 'tui', handoffStage: 'old-owner-stopped' })
    expect(normalizeLegacyHandoffLease(lease)).toMatchObject({
      runtimeKind: 'native',
      handoffStage: 'recovering',
      claimStatus: 'conflicted'
    })
  })
})
