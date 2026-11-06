// The facts released clients read as loose top-level refusal fields, and how they are read back.

import { isAgentJournalResolution } from '../journal/agent-session-journal-schemas'
import type { AgentJournalResolution } from '../journal/agent-session-journal-types'
import {
  AGENT_SESSION_REWIND_REASONS,
  type AgentSessionRewindReason
} from '../lifecycle/agent-session-rewind'
import type {
  AgentSessionOwnerVerdict,
  AgentSessionWireRefusalCode
} from './agent-session-wire-refusals'

/** The loose top-level fields released clients read; the host writes them only from details. */
export type AgentSessionLegacyRefusalFields = {
  currentFence?: number
  currentRevision?: number
  resolution?: AgentJournalResolution
  ownerVerdict?: AgentSessionOwnerVerdict
  rewindReason?: AgentSessionRewindReason
}

const FACT_KEYS_BY_CODE: Partial<
  Record<AgentSessionWireRefusalCode, readonly (keyof AgentSessionLegacyRefusalFields)[]>
> = {
  agent_session_operation_invalid: ['rewindReason'],
  agent_session_operation_unknown: ['rewindReason'],
  agent_session_checkpoint_stale: ['currentFence'],
  agent_session_item_revision_stale: ['currentRevision', 'resolution'],
  agent_session_already_resolved: ['currentRevision', 'resolution']
}

const OWNER_VERDICTS: readonly AgentSessionOwnerVerdict[] = ['live', 'unverifiable', 'exited']

function readFact(
  key: keyof AgentSessionLegacyRefusalFields,
  value: unknown
): AgentSessionLegacyRefusalFields {
  switch (key) {
    case 'currentFence':
      return Number.isSafeInteger(value) && typeof value === 'number' ? { currentFence: value } : {}
    case 'currentRevision':
      return Number.isSafeInteger(value) && typeof value === 'number'
        ? { currentRevision: value }
        : {}
    case 'resolution':
      return isAgentJournalResolution(value) ? { resolution: value } : {}
    case 'ownerVerdict': {
      const ownerVerdict = OWNER_VERDICTS.find((verdict) => verdict === value)
      return ownerVerdict ? { ownerVerdict } : {}
    }
    case 'rewindReason': {
      const rewindReason = AGENT_SESSION_REWIND_REASONS.find((reason) => reason === value)
      return rewindReason ? { rewindReason } : {}
    }
  }
}

/** The legacy facts listed for `code`, plus the verdict every code may carry. */
export function readAgentSessionLegacyRefusalFacts(
  code: AgentSessionWireRefusalCode,
  value: Record<string, unknown>
): AgentSessionLegacyRefusalFields {
  const keys = [...(FACT_KEYS_BY_CODE[code] ?? []), 'ownerVerdict' as const]
  return keys.reduce<AgentSessionLegacyRefusalFields>(
    (kept, key) => ({ ...kept, ...readFact(key, value[key]) }),
    {}
  )
}

/** The loose fields released clients read, taken from details; the one place they are written. */
export function agentSessionLegacyRefusalFields(
  details: AgentSessionLegacyRefusalFields | undefined
): AgentSessionLegacyRefusalFields {
  if (!details) {
    return {}
  }
  const { currentFence, currentRevision, resolution, ownerVerdict, rewindReason } = details
  return {
    ...(rewindReason !== undefined ? { rewindReason } : {}),
    ...(currentFence !== undefined ? { currentFence } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(currentRevision !== undefined ? { currentRevision } : {}),
    ...(ownerVerdict !== undefined ? { ownerVerdict } : {})
  }
}
