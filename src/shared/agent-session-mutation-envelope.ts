// Admission for one mutating `agentSession.*` call.
//
// The rules themselves live in the durable ledger and the lease adjudicator;
// this is only the fixed order they are applied in, plus the payload
// fingerprint both peers derive from the same request fields. Nothing here
// re-derives who may write — that answer comes from
// `agentSessionLeaseAdmitsWriter` alone.

import { createHash } from 'node:crypto'
import type {
  AgentSessionOperationDecision,
  AgentSessionOperationRow
} from './agent-session-operation-ledger'
import {
  agentSessionLeaseAdmitsWriter,
  isAgentSessionFenceCurrent
} from './agent-session-lease-adjudication'
import type { AgentSessionLease } from './agent-session-record'
import type { AgentSessionMutationEnvelope, AgentSessionWireRefusal } from './agent-session-wire'

/**
 * Stable digest over the fields that define what this call DOES. Keys are
 * emitted in sorted order at every depth so two peers serializing the same
 * request in different property order agree, and an undefined field is dropped
 * rather than hashed as present-but-empty.
 */
export function computeAgentSessionPayloadFingerprint(input: {
  method: string
  sessionId: string
  fields: Record<string, unknown>
}): string {
  const canonical = canonicalize({
    method: input.method,
    sessionId: input.sessionId,
    fields: input.fields
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`
}

/**
 * A retry whose payload changed is a different call wearing the same id.
 * Checked BEFORE the ledger is consulted, so a refused call never leaves an
 * admitted row that a later honest retry would replay as already-done.
 */
export function agentSessionFingerprintConflict(
  envelope: AgentSessionMutationEnvelope,
  hostFingerprint: string
): AgentSessionWireRefusal | null {
  return envelope.payloadFingerprint === hostFingerprint
    ? null
    : {
        code: 'agent_session_operation_conflict',
        message:
          'The payload does not match the fingerprint the client declared for this operation.'
      }
}

export type AgentSessionMutationAdmission =
  | { decision: 'admit'; row: AgentSessionOperationRow }
  /** The recorded outcome answers this call; do not run the effect again. */
  | { decision: 'replay'; row: AgentSessionOperationRow }
  | { decision: 'refused'; refusal: AgentSessionWireRefusal }

/**
 * Fixed order: fingerprint agreement, then the ledger (so a retry replays
 * before anything else can refuse it), then the lease, then the fence. Putting
 * the ledger ahead of the fence is deliberate — a retry that crossed an owner
 * change must still return its recorded answer instead of a stale-checkpoint
 * refusal the client would then resend as a second effect.
 */
export function admitAgentSessionMutation(input: {
  envelope: AgentSessionMutationEnvelope
  /** Fingerprint the host computed from the request it actually received. */
  hostFingerprint: string
  /** Decision from the durable ledger, evaluated under `hostFingerprint`. */
  ledger: AgentSessionOperationDecision
  lease: AgentSessionLease
}): AgentSessionMutationAdmission {
  const { envelope, lease, ledger } = input
  const mismatch = agentSessionFingerprintConflict(envelope, input.hostFingerprint)
  if (mismatch) {
    return { decision: 'refused', refusal: mismatch }
  }
  if (ledger.decision === 'refused') {
    return {
      decision: 'refused',
      refusal: {
        code: ledger.code,
        message: `Operation ${envelope.clientOperationId} was refused: ${ledger.code}.`
      }
    }
  }
  if (ledger.decision === 'replay') {
    return { decision: 'replay', row: ledger.row }
  }
  const leaseRefusal = refuseUnlessWriterAdmitted(lease)
  if (leaseRefusal) {
    return { decision: 'refused', refusal: leaseRefusal }
  }
  if (
    envelope.expectedRuntimeFence === null ||
    !isAgentSessionFenceCurrent(lease, envelope.expectedRuntimeFence)
  ) {
    return {
      decision: 'refused',
      refusal: {
        code: 'agent_session_checkpoint_stale',
        message: `Expected runtime fence ${envelope.expectedRuntimeFence ?? 'none'}; the session is at ${lease.runtimeFence}.`,
        currentFence: lease.runtimeFence
      }
    }
  }
  return { decision: 'admit', row: ledger.row }
}

/** Why the single admission oracle said no, mapped to what the client can do
 *  about it. The predicate itself is never re-implemented here. */
function refuseUnlessWriterAdmitted(lease: AgentSessionLease): AgentSessionWireRefusal | null {
  if (lease.runtimeKind === 'native' && agentSessionLeaseAdmitsWriter(lease)) {
    return null
  }
  if (lease.unreconciled) {
    return {
      code: 'execution_owner_reconciling',
      message: 'This host has not yet adjudicated the session lease.'
    }
  }
  if (lease.handoffStage !== null) {
    return {
      code: 'agent_session_conflict',
      message: `The session is mid-handoff (${lease.handoffStage}).`
    }
  }
  if (lease.runtimeKind === 'tui' && agentSessionLeaseAdmitsWriter(lease)) {
    return {
      code: 'agent_session_conflict',
      message: 'The agent terminal owns this session.'
    }
  }
  return {
    code: 'agent_session_ownership_unknown',
    message: 'The session has no live owner to accept writes.'
  }
}
