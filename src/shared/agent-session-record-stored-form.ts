/** Decode stored Claude/Codex typed handles and legacy leases without changing what older builds can read. */

import {
  leaseCarriesLegacyHandoffValues,
  normalizeLegacyHandoffLease,
  type PersistedAgentSessionRecord,
  type PersistedAgentSessionObservationLease
} from './agent-session-legacy-handoff-lease'
import {
  decodePersistedAgentSessionProviderHandleChain,
  encodePersistedAgentSessionProviderHandleChain
} from './agent-session-provider-handle'
import { isAgentSessionLastTurn } from './agent-session-last-turn'
import type { AgentSessionDeathEvidence, AgentSessionRecord } from './agent-session-record'

// Older builds accept only exit-observed, pid-absent and identity-mismatch and set aside any other
// row, so a delivered kill is stored as the absent pid their restart probe would itself record.
const KILL_DELIVERY_MARKER = 'kill'

type PersistedDeathEvidence = AgentSessionDeathEvidence & { delivery?: unknown }

function encodeDeathEvidence(
  evidence: AgentSessionDeathEvidence | null
): PersistedDeathEvidence | null {
  return evidence?.kind === 'kill-delivered'
    ? { ...evidence, kind: 'pid-absent', delivery: KILL_DELIVERY_MARKER }
    : evidence
}

/** Only the exact stored pair means a delivered kill; any other marker is dropped unread. */
function decodeDeathEvidence(
  evidence: PersistedDeathEvidence | null
): AgentSessionDeathEvidence | null {
  if (!evidence || !Object.hasOwn(evidence, 'delivery')) {
    return evidence
  }
  const { delivery, ...rest } = evidence
  return delivery === KILL_DELIVERY_MARKER && rest.kind === 'pid-absent'
    ? { ...rest, kind: 'kill-delivered' }
    : rest
}

/** Report decode changes needing writeback; handle encoding alone is unchanged across builds and needs none. */
export function decodePersistedAgentSessionRecord<L extends PersistedAgentSessionObservationLease>(
  record: Omit<PersistedAgentSessionRecord, 'lease'> & { lease: L }
) {
  const providerHandleChain = decodePersistedAgentSessionProviderHandleChain(
    record.providerHandleChain
  )
  if (!providerHandleChain) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  const { sleptAt, lastTurn, ...rest } = record
  const validSleep = typeof sleptAt === 'number' && Number.isFinite(sleptAt) && sleptAt > 0
  const lease = normalizeLegacyHandoffLease(record.lease)
  return {
    record: {
      ...rest,
      ...(validSleep ? { sleptAt } : {}),
      ...(isAgentSessionLastTurn(lastTurn) ? { lastTurn } : {}),
      providerHandleChain,
      lease: { ...lease, deathEvidence: decodeDeathEvidence(lease.deathEvidence) }
    },
    normalized:
      leaseCarriesLegacyHandoffValues(record.lease) || (sleptAt !== undefined && !validSleep)
  }
}

/** The record as a row stores it; Claude and Codex handles and death evidence keep the forms older builds read. */
export function encodeAgentSessionRecord(record: AgentSessionRecord): PersistedAgentSessionRecord {
  return {
    ...record,
    lease: { ...record.lease, deathEvidence: encodeDeathEvidence(record.lease.deathEvidence) },
    providerHandleChain: encodePersistedAgentSessionProviderHandleChain(record.providerHandleChain)
  }
}
