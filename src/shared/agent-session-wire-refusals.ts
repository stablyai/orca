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

/** For a host path that raises its refusal as the thrown code. Narrowing through this keeps an
 *  unrelated fault from being reported to the client as a tidy, wrong refusal. */
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

/** A refusal built at its emitter. The reason must be one `code` lists; the legacy top-level fields
 *  released clients read are copied from `details` here and nowhere else. */
export function refuse<C extends AgentSessionWireRefusalCode>(
  code: C,
  details: NoInfer<AgentSessionRefusalDetailsByCode[C]>,
  message: string
): AgentSessionWireRefusal {
  return buildRefusal(code, details, message)
}

/**
 * A refusal whose situation this site cannot name: the code, and whatever facts it does know, with
 * no reason, exactly as an older host sends it. The explicit path, so no emitter reaches for a
 * catch-all reason instead.
 */
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

/** A reference read back from a record another build may have written; details are checked
 *  against the code, and anything else they held (an older build's `cause`) is dropped. */
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

/**
 * A refusal raised rather than returned. Its message is the bare code, exactly as the
 * `Error(code)` it replaces: the RPC passthrough, the restart-resume ledger and released clients
 * all read a thrown refusal's message as its code. The details ride on `refusal` and reach the
 * client only in the RPC error's data. Deliberately no `code` property, so no `'code' in error`
 * passthrough meant for another subsystem can claim it.
 */
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
