/**
 * PTY-write admission for agent sessions that have a durable record.
 *
 * A PTY is the TUI runtime's write surface, so bytes may enter it only while the session's lease
 * admits a writer and that writer is the TUI. The admit decision is `agentSessionLeaseAdmitsWriter`
 * verbatim; everything here only decides whether the lease is even the TUI's to hold, and — once
 * that helper has already refused — which refusal a client should be shown.
 *
 * A PTY with no binding is a session this host knows nothing about: every ordinary shell and every
 * legacy agent terminal. Those are never consulted and never refused. A binding whose record is
 * missing is the opposite case — the record was lost, not absent — and fails closed.
 */

import {
  agentSessionLeaseAdmitsWriter,
  isAgentSessionFenceCurrent
} from './agent-session-lease-adjudication'
import type {
  AgentSessionHandoffStage,
  AgentSessionLease,
  AgentSessionOwnerRuntimeKind,
  AgentSessionRecord
} from './agent-session-record'

/**
 * Every code is already in `AGENT_SESSION_RPC_ERROR_CODES`, so a refusal reaching an old client
 * carries a code it has seen since the host-authority release rather than a new one.
 */
export type AgentSessionPtyWriteRefusalCode =
  | 'agent_session_conflict'
  | 'agent_session_ownership_unknown'
  | 'agent_session_checkpoint_stale'
  | 'execution_owner_reconciling'

export type AgentSessionPtyWriteRefusal = {
  code: AgentSessionPtyWriteRefusalCode
  sessionId: string
  /** Runtime the lease names as owner; null once the record is gone. */
  ownerRuntimeKind: AgentSessionOwnerRuntimeKind | null
  handoffStage: AgentSessionHandoffStage | null
  /** Pid the lease names, so the refusal can say who holds the session. */
  ownerPid: number | null
  runtimeFence: number | null
}

export type AgentSessionPtyWriteAdmission =
  | { admitted: true; sessionId: string | null; runtimeFence: number | null }
  | { admitted: false; refusal: AgentSessionPtyWriteRefusal }

/** One PTY's durable binding: the session it belongs to and that session's record, if readable. */
export type AgentSessionPtyBinding = {
  sessionId: string
  record: AgentSessionRecord | null
}

const UNBOUND_ADMISSION: AgentSessionPtyWriteAdmission = {
  admitted: true,
  sessionId: null,
  runtimeFence: null
}

/** Runs only after `agentSessionLeaseAdmitsWriter` (or the runtime-kind test) already refused. */
function classifyRefusal(lease: AgentSessionLease): AgentSessionPtyWriteRefusalCode {
  if (lease.unreconciled) {
    return 'execution_owner_reconciling'
  }
  if (lease.claimStatus === 'conflicted') {
    return 'agent_session_conflict'
  }
  if (lease.handoffStage === 'recovering' || lease.handoffStage === 'manual-recovery') {
    return 'execution_owner_reconciling'
  }
  if (lease.handoffStage !== null || lease.runtimeKind !== 'tui') {
    // Why: a live native owner and a mid-flight handoff are both "someone else holds it", which is
    // actionable in a way "we cannot tell" is not.
    return 'agent_session_conflict'
  }
  return 'agent_session_ownership_unknown'
}

function refuse(
  code: AgentSessionPtyWriteRefusalCode,
  sessionId: string,
  lease: AgentSessionLease | null
): AgentSessionPtyWriteAdmission {
  return {
    admitted: false,
    refusal: {
      code,
      sessionId,
      ownerRuntimeKind: lease?.runtimeKind ?? null,
      handoffStage: lease?.handoffStage ?? null,
      ownerPid: lease?.ownerProcess?.pid ?? null,
      runtimeFence: lease?.runtimeFence ?? null
    }
  }
}

export function evaluateAgentSessionPtyWriteAdmission(
  binding: AgentSessionPtyBinding | null
): AgentSessionPtyWriteAdmission {
  if (!binding) {
    return UNBOUND_ADMISSION
  }
  const record = binding.record
  if (!record) {
    // Why: a bound PTY whose record cannot be read is a lost lease, not an unmanaged shell.
    return refuse('execution_owner_reconciling', binding.sessionId, null)
  }
  if (record.sessionId !== binding.sessionId) {
    return refuse('agent_session_ownership_unknown', binding.sessionId, record.lease)
  }
  const lease = record.lease
  if (lease.runtimeKind === 'tui' && agentSessionLeaseAdmitsWriter(lease)) {
    return { admitted: true, sessionId: record.sessionId, runtimeFence: lease.runtimeFence }
  }
  return refuse(classifyRefusal(lease), binding.sessionId, lease)
}

/**
 * Re-admit a write that already began. Chunked input and the text/suffix pause both yield, so a
 * lease transition can land between two writes of one logical send; the fence observed at
 * admission is what the remaining bytes are checked against.
 */
export function reevaluateAgentSessionPtyWriteAdmission(args: {
  admitted: { sessionId: string | null; runtimeFence: number | null }
  binding: AgentSessionPtyBinding | null
}): AgentSessionPtyWriteAdmission {
  const { admitted, binding } = args
  const next = evaluateAgentSessionPtyWriteAdmission(binding)
  if (admitted.sessionId === null || admitted.runtimeFence === null) {
    // Why: an unbound write that acquires a binding mid-flight is judged on the new binding alone.
    return next
  }
  if (!next.admitted) {
    return next
  }
  const lease = binding?.record?.lease ?? null
  if (
    next.sessionId !== admitted.sessionId ||
    !lease ||
    !isAgentSessionFenceCurrent(lease, admitted.runtimeFence)
  ) {
    return refuse('agent_session_checkpoint_stale', admitted.sessionId, lease)
  }
  return next
}

export class AgentSessionPtyWriteRefusedError extends Error {
  readonly refusal: AgentSessionPtyWriteRefusal

  constructor(refusal: AgentSessionPtyWriteRefusal) {
    // Why: callers that already switch on `error.message` as an RPC code keep working unchanged.
    super(refusal.code)
    this.name = 'AgentSessionPtyWriteRefusedError'
    this.refusal = refusal
  }
}

export function isAgentSessionPtyWriteRefusedError(
  error: unknown
): error is AgentSessionPtyWriteRefusedError {
  return error instanceof AgentSessionPtyWriteRefusedError
}

/** Human-readable refusal, so a client that only surfaces a message still names the owner. */
export function describeAgentSessionPtyWriteRefusal(refusal: AgentSessionPtyWriteRefusal): string {
  const owner =
    refusal.ownerRuntimeKind === null
      ? 'no recorded owner'
      : `${refusal.ownerRuntimeKind === 'native' ? 'native chat' : 'the agent TUI'}${
          refusal.ownerPid === null ? '' : ` (pid ${refusal.ownerPid})`
        }`
  const stage =
    refusal.handoffStage === null ? 'no handoff in progress' : `handoff ${refusal.handoffStage}`
  return `Agent session ${refusal.sessionId} is held by ${owner}; ${stage} (${refusal.code}).`
}
