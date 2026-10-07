// A chat write that did not happen, as a fact: what the person was doing, and what the host said.
// Saved with a queued message, so it holds only what stays true after a reload; the words are
// chosen from it when it is shown (`agent-session-refusal-notice.ts`).

import {
  readAgentSessionRefusalDetails,
  type AgentSessionRefusalReason
} from './agent-session-refusal-details'
import type { AgentSessionRewindReason } from './agent-session-rewind'
import type { AgentSessionArgumentProblem } from './agent-session-argument-problem'
import {
  isAgentSessionWireRefusalCode,
  readAgentSessionRefusalReference,
  type AgentSessionOwnerVerdict,
  type AgentSessionRefusalReference,
  type AgentSessionWireRefusal,
  type AgentSessionWireRefusalCode
} from './agent-session-wire-refusals'

/** What the person was doing, which decides what the notice says did not happen. `send` keeps
 *  the message behind a Retry control; `composer-send` puts it back in the composer, as the phone
 *  does. `read-history` is opening the chat to show its history, which writes nothing. */
export type AgentSessionWriteKind =
  | 'read-history'
  | 'send'
  | 'composer-send'
  | 'stop'
  | 'stop-task'
  | 'stop-tasks'
  | 'answer'
  | 'option'
  | 'command'
  | 'goal'

/** The kind of write an `agentSession.*` call stands for. */
export function agentSessionWriteKindForMethod(
  fingerprintMethod: string,
  fields: Record<string, unknown>
): AgentSessionWriteKind {
  if (fingerprintMethod === 'agentSession.send') {
    return 'send'
  }
  if (fingerprintMethod === 'agentSession.cancel') {
    // A background-task stop never asked the agent to stop.
    if (fields.scope !== 'background-tasks') {
      return 'stop'
    }
    return typeof fields.taskId === 'string' ? 'stop-task' : 'stop-tasks'
  }
  if (fingerprintMethod.startsWith('agentSession.respondTo')) {
    return 'answer'
  }
  if (fingerprintMethod === 'agentSession.setOption') {
    return 'option'
  }
  if (fingerprintMethod === 'agentSession.threadGoal') {
    return 'goal'
  }
  return 'command'
}

/** What a saved refusal keeps beside its reason: facts about the refused operation that stay true
 *  after a reload. Never the fence, revision or resolution, which move, nor any provider text. */
type DurableRefusalFacts = {
  agent_session_operation_invalid: {
    rewindReason?: AgentSessionRewindReason
    argumentProblem?: AgentSessionArgumentProblem
  }
  agent_session_operation_unknown: { rewindReason?: AgentSessionRewindReason }
  /** A snapshot from when it was refused; see `agentSessionOwnerVerdictAllowsFreshOperationId`. */
  agent_session_ownership_unknown: { ownerVerdict?: AgentSessionOwnerVerdict }
  agent_session_operation_capacity: { capacityReturnsAt?: number }
}

const DURABLE_FACT_KEYS: Partial<Record<AgentSessionWireRefusalCode, readonly string[]>> = {
  agent_session_operation_invalid: ['rewindReason', 'argumentProblem'],
  agent_session_operation_unknown: ['rewindReason'],
  agent_session_ownership_unknown: ['ownerVerdict'],
  agent_session_operation_capacity: ['capacityReturnsAt']
} satisfies { [C in keyof DurableRefusalFacts]: readonly (keyof DurableRefusalFacts[C])[] }

export type AgentSessionWriteRefusalDetails<C extends AgentSessionWireRefusalCode> = {
  reason?: AgentSessionRefusalReason<C>
} & (C extends keyof DurableRefusalFacts ? DurableRefusalFacts[C] : Record<never, never>)

/** A refused write: its code, and what the host said about it that outlives the reply. */
export type AgentSessionWriteRefusal = {
  [C in AgentSessionWireRefusalCode]: {
    kind: 'refused'
    code: C
    /** Absent from older hosts and from entries saved before refusals carried a reason. */
    details?: AgentSessionWriteRefusalDetails<C>
  }
}[AgentSessionWireRefusalCode]

/** Why a write did not happen, or that nothing proves it did not. */
export type AgentSessionWriteFailure =
  | AgentSessionWriteRefusal
  /** The request failed without a refusal before the host ran it, so nothing is known about why. */
  | { kind: 'failed' }
  /** The request failed where the host may already have run it (a timeout, a lost connection, an
   *  error inside the method). */
  | { kind: 'unconfirmed' }

/** The refusal as a write keeps it. Details are read against the code, so a reason or verdict
 *  another build added is dropped and the code's own words stand. */
function agentSessionWriteRefusal(
  code: AgentSessionWireRefusalCode,
  details: unknown
): AgentSessionWriteRefusal {
  const durable: readonly string[] = ['reason', ...(DURABLE_FACT_KEYS[code] ?? [])]
  const kept = Object.fromEntries(
    Object.entries(readAgentSessionRefusalDetails(code, details) ?? {}).filter(([key]) =>
      durable.includes(key)
    )
  )
  const refusal = {
    kind: 'refused',
    code,
    ...(Object.keys(kept).length > 0 ? { details: kept } : {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `kept` holds only a reason and facts read against `code` and allowed for it above.
  return refusal as AgentSessionWriteRefusal
}

export function agentSessionRefusalFailure(
  refusal: Pick<AgentSessionWireRefusal, 'code' | 'details'>
): AgentSessionWriteRefusal {
  // A newer host can send a code this client has never heard of; its details mean nothing here.
  return isAgentSessionWireRefusalCode(refusal.code)
    ? agentSessionWriteRefusal(refusal.code, refusal.details)
    : { kind: 'refused', code: refusal.code }
}

/** A request that threw, from the RPC error code the host answered with (undefined when none came
 *  back). Only a host that turned it away before running the method proves the write did not
 *  happen. */
export function agentSessionRpcErrorFailure(code: string | undefined): AgentSessionWriteFailure {
  if (code === 'method_not_found' || code === 'method_not_supported') {
    return { kind: 'refused', code: 'structured_agent_session_unsupported' }
  }
  return code === 'invalid_argument' || code === 'unauthorized'
    ? { kind: 'refused', code: 'agent_session_operation_invalid' }
    : { kind: 'unconfirmed' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The refusal a failed request's error carries in its data. Takes both shapes a client meets: an
 *  RPC call's thrown error, whose payload is on `response.error`, and the payload a stream hands
 *  its error callback. Undefined from an older host, or for a failure that was not a refusal. */
export function readAgentSessionErrorRefusal(
  error: unknown
): AgentSessionRefusalReference | undefined {
  const payload =
    isRecord(error) && isRecord(error.response) && isRecord(error.response.error)
      ? error.response.error
      : error
  const data = isRecord(payload) ? payload.data : undefined
  return isRecord(data) ? readAgentSessionRefusalReference(data.refusal) : undefined
}

/** What to say about a request that threw: the host's refusal when its error carried one, else
 *  what the RPC error code proves. Words only: whether the write may have happened stays the
 *  caller's own classification. */
export function agentSessionThrownFailure(
  error: unknown,
  rpcCode: string | undefined
): AgentSessionWriteFailure {
  const refusal = readAgentSessionErrorRefusal(error)
  return refusal ? agentSessionRefusalFailure(refusal) : agentSessionRpcErrorFailure(rpcCode)
}

/** A saved failure, or undefined when it is not one this build wrote. */
export function parseAgentSessionWriteFailure(
  value: unknown
): AgentSessionWriteFailure | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return undefined
  }
  if (value.kind === 'failed') {
    return { kind: 'failed' }
  }
  return value.kind === 'refused' && 'code' in value && isAgentSessionWireRefusalCode(value.code)
    ? agentSessionWriteRefusal(value.code, 'details' in value ? value.details : undefined)
    : undefined
}
