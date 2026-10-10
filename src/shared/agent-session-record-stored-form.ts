/**
 * An agent-session record between its stored row and memory. The stored row keeps what older
 * builds read: Claude and Codex handles in their typed form and lease values only they wrote.
 */

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
import { readAgentSessionModelChooser } from './agent-session-options-replacement'

/** The in-memory record, plus whether decode changed anything the store must write back. A
 *  handle's stored form is not such a change: every build writes it the same way. */
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
  const { modelChosenBy: storedChooser, ...stored } = record
  const modelChosenBy = readAgentSessionModelChooser(storedChooser)
  return {
    record: {
      ...stored,
      ...(modelChosenBy ? { modelChosenBy } : {}),
      providerHandleChain,
      lease: normalizeLegacyHandoffLease(record.lease)
    },
    normalized: leaseCarriesLegacyHandoffValues(record.lease)
  }
}

/** The record as a row stores it; Claude and Codex handles keep the typed form older builds read. */
export function encodeAgentSessionRecord(record: AgentSessionRecord): PersistedAgentSessionRecord {
  return {
    ...record,
    providerHandleChain: encodePersistedAgentSessionProviderHandleChain(record.providerHandleChain)
  }
}
