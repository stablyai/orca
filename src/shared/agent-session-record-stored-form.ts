/** Decode stored Claude/Codex typed handles and legacy leases without changing what older builds can read. */

import {
  leaseCarriesLegacyHandoffValues,
  normalizeLegacyHandoffLease,
  type PersistedAgentSessionRecord
} from './agent-session-legacy-handoff-lease'
import {
  decodePersistedAgentSessionProviderHandleChain,
  encodePersistedAgentSessionProviderHandleChain
} from './agent-session-provider-handle'
import type { AgentSessionRecord } from './agent-session-record'

/** Report decode changes needing writeback; handle encoding alone is unchanged across builds and needs none. */
export function decodePersistedAgentSessionRecord(record: PersistedAgentSessionRecord): {
  record: AgentSessionRecord
  normalized: boolean
} {
  const providerHandleChain = decodePersistedAgentSessionProviderHandleChain(
    record.providerHandleChain
  )
  if (!providerHandleChain) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  const { sleptAt, ...rest } = record
  const validSleep = typeof sleptAt === 'number' && Number.isFinite(sleptAt) && sleptAt > 0
  return {
    record: {
      ...rest,
      ...(validSleep ? { sleptAt } : {}),
      providerHandleChain,
      lease: normalizeLegacyHandoffLease(record.lease)
    },
    normalized:
      leaseCarriesLegacyHandoffValues(record.lease) || (sleptAt !== undefined && !validSleep)
  }
}

/** The record as a row stores it; Claude and Codex handles keep the typed form older builds read. */
export function encodeAgentSessionRecord(record: AgentSessionRecord): PersistedAgentSessionRecord {
  return {
    ...record,
    providerHandleChain: encodePersistedAgentSessionProviderHandleChain(record.providerHandleChain)
  }
}
