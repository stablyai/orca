import { describe, expect, it } from 'vitest'
import {
  leaseCarriesLegacyHandoffValues,
  normalizeLegacyHandoffLease,
  normalizeLegacyHandoffRecord,
  type PersistedAgentSessionLease
} from './agent-session-legacy-handoff-lease'
import type { AgentSessionClaimStatus, AgentSessionHandoffStage } from './agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from './agent-session-record.test-fixture'

const CLAIMS: AgentSessionClaimStatus[] = ['reserved', 'live', 'conflicted', 'released']
const STAGES: (AgentSessionHandoffStage | null)[] = [
  null,
  'new-owner-proving',
  'recovering',
  'manual-recovery'
]

function persisted(overrides: Partial<PersistedAgentSessionLease>): PersistedAgentSessionLease {
  return { ...agentSessionLeaseFixture(), ...overrides }
}

describe('normalizing a lease the removed terminal handoff wrote', () => {
  it('leaves every lease this build writes as it is', () => {
    for (const claimStatus of CLAIMS) {
      for (const handoffStage of STAGES) {
        for (const ownerProcess of [agentSessionLeaseFixture().ownerProcess, null]) {
          const lease = agentSessionLeaseFixture({ claimStatus, handoffStage, ownerProcess })
          expect(normalizeLegacyHandoffLease(lease)).toEqual(lease)
          expect(leaseCarriesLegacyHandoffValues(lease)).toBe(false)
        }
      }
    }
  })

  it.each(['preparing', 'old-owner-stopped'] as const)(
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

  it('reports whether a record needed normalizing', () => {
    const record = agentSessionRecordFixture()
    expect(normalizeLegacyHandoffRecord(record)).toEqual({ record, normalized: false })
    const legacy = { ...record, lease: persisted({ runtimeKind: 'tui' }) }
    expect(normalizeLegacyHandoffRecord(legacy)).toEqual({
      record: { ...record, lease: { ...record.lease, claimStatus: 'conflicted' } },
      normalized: true
    })
  })
})
