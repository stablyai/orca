// How the host declines an `agentSession.*` mutation: the closed code list, its
// narrowing guard, and the refusal body a client reads.

import {
  agentSessionLegacyRefusalFields,
  readAgentSessionRefusalDetails,
  type AgentSessionAnyRefusalDetails,
  type AgentSessionLegacyRefusalFields,
  type AgentSessionRefusalDetails,
  type AgentSessionRefusalDetailsByCode,
  type AgentSessionRefusalFacts
} from './agent-session-refusal-details'

export type {
  AgentSessionAnyRefusalDetails,
  AgentSessionAnyRefusalReason,
  AgentSessionLegacyRefusalFields,
  AgentSessionRefusalDetails,
  AgentSessionRefusalDetailsByCode,
  AgentSessionRefusalReason
} from './agent-session-refusal-details'

export const AGENT_SESSION_WIRE_REFUSAL_CODES = [
  'structured_agent_session_unsupported',
  'agent_session_checkpoint_stale',
  'agent_session_conflict',
  'agent_session_ownership_unknown',
  'agent_session_operation_conflict',
  'agent_session_operation_expired',
  'agent_session_operation_capacity',
  'agent_session_operation_invalid',
  'agent_session_operation_unknown',
  'agent_session_item_revision_stale',
  'agent_session_already_resolved',
  'agent_session_identity_required',
  'agent_session_journal_unreadable',
  'execution_owner_reconciling',
  // Older clients hold an unknown code as a blocked send with the host's message shown.
  'agent_session_owner_restart_failed'
] as const
export type AgentSessionWireRefusalCode = (typeof AGENT_SESSION_WIRE_REFUSAL_CODES)[number]

/** Narrow thrown refusal codes so unrelated faults cannot become tidy but incorrect client refusals. */
export function isAgentSessionWireRefusalCode(
  value: unknown
): value is AgentSessionWireRefusalCode {
  return (
    typeof value === 'string' &&
    (AGENT_SESSION_WIRE_REFUSAL_CODES as readonly string[]).includes(value)
  )
}

/** What the host last proved about a session's provider process; see the SSH execution boundary. */
export type AgentSessionOwnerVerdict = 'live' | 'unverifiable' | 'exited'

/** One variant per code, so a refusal's details can only be that code's. */
export type AgentSessionRefusalOf<C extends AgentSessionWireRefusalCode> = {
  [K in C]: {
    code: K
    /** For logs and released clients, which print it; newer clients choose words from details. */
    message: string
    /** Absent from older hosts. */
    details?: AgentSessionRefusalDetails<K>
    /** This create attempt refused before commit; earlier attempts may still have committed. */
    createAttemptRefusedBeforeCommit?: true
  } & AgentSessionLegacyRefusalFields
}[C]

export type AgentSessionWireRefusal = AgentSessionRefusalOf<AgentSessionWireRefusalCode>

/** A refusal named without its prose: what a durable record or an error's data keeps. */
export type AgentSessionRefusalReference = {
  [K in AgentSessionWireRefusalCode]: { code: K; details?: AgentSessionRefusalDetails<K> }
}[AgentSessionWireRefusalCode]

function buildRefusal(
  code: AgentSessionWireRefusalCode,
  details: AgentSessionAnyRefusalDetails | undefined,
  message: string
): AgentSessionWireRefusal {
  const kept = details && Object.keys(details).length > 0 ? details : undefined
  const refusal = {
    code,
    message,
    ...(kept ? { details: kept } : {}),
    ...agentSessionLegacyRefusalFields(kept)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every caller passes details typed for `code` (refuse and refuseUnclassified by their signatures, the reference by its own union).
  return refusal as AgentSessionWireRefusal
}

/** Require a reason listed for code; copy legacy top-level fields only here from details. */
export function refuse<C extends AgentSessionWireRefusalCode>(
  code: C,
  details: NoInfer<AgentSessionRefusalDetailsByCode[C]>,
  message: string
): AgentSessionWireRefusal {
  return buildRefusal(code, details, message)
}

/** Explicitly emit code/facts without a reason when the situation is unclassified; never invent a catch-all reason. */
export function refuseUnclassified<C extends AgentSessionWireRefusalCode>(
  code: C,
  message: string,
  facts?: NoInfer<AgentSessionRefusalFacts<C>>
): AgentSessionWireRefusal {
  return buildRefusal(code, facts, message)
}

/** A refusal rebuilt from what a record or a decision kept of it. */
export function agentSessionRefusalFromReference(
  reference: AgentSessionRefusalReference,
  message: string
): AgentSessionWireRefusal {
  return buildRefusal(reference.code, reference.details, message)
}

/** The same refusal with more facts: a failed create's verdict, learned after the refusal was. */
export function withAgentSessionRefusalFacts(
  refusal: AgentSessionWireRefusal,
  facts: { ownerVerdict: AgentSessionOwnerVerdict }
): AgentSessionWireRefusal {
  return buildRefusal(refusal.code, { ...refusal.details, ...facts }, refusal.message)
}

/** The refusal reduced to what may be stored or put in an error's data. */
export function agentSessionRefusalReference(
  refusal: AgentSessionWireRefusal
): AgentSessionRefusalReference {
  return buildReference(refusal.code, refusal.details)
}

/** Check stored details against code and discard unknown fields, including legacy cause. */
export function readAgentSessionRefusalReference(
  value: unknown
): AgentSessionRefusalReference | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('code' in value) ||
    !isAgentSessionWireRefusalCode(value.code)
  ) {
    return undefined
  }
  return buildReference(
    value.code,
    'details' in value ? readAgentSessionRefusalDetails(value.code, value.details) : undefined
  )
}

function buildReference(
  code: AgentSessionWireRefusalCode,
  details: AgentSessionAnyRefusalDetails | undefined
): AgentSessionRefusalReference {
  const reference = { code, ...(details ? { details } : {}) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `details` is the refusal's own, or was read against `code`.
  return reference as AgentSessionRefusalReference
}

/** Keep thrown message as bare code for RPC passthrough, restart ledger and released clients. Carry details only through refusal/RPC error data; omit a code property to avoid unrelated subsystem passthrough. */
export class AgentSessionRefusalError extends Error {
  readonly refusal: AgentSessionWireRefusal

  constructor(refusal: AgentSessionWireRefusal, options?: { cause?: unknown }) {
    super(refusal.code, options)
    this.name = 'AgentSessionRefusalError'
    this.refusal = refusal
  }
}

/** A store or host refusal thrown under its situation; the error's message stays the code. */
export function agentSessionRefusalError<C extends AgentSessionWireRefusalCode>(
  code: C,
  details: NoInfer<AgentSessionRefusalDetailsByCode[C]>,
  message: string = code
): AgentSessionRefusalError {
  return new AgentSessionRefusalError(refuse(code, details, message))
}

export function isAgentSessionRefusalError(error: unknown): error is AgentSessionRefusalError {
  return error instanceof AgentSessionRefusalError
}
