// Persist durable write-failure facts with queued cards; choose words at display via agent-session-refusal-notice.ts.

import type { AgentSessionAccountKind } from './agent-session-availability'
import {
  readAgentSessionRefusalDetails,
  type AgentSessionRefusalReason
} from './agent-session-refusal-details'
import type { AgentSessionRewindReason } from './agent-session-rewind'
import type { AgentSessionArgumentProblem } from './agent-session-argument-problem'
import type { TuiAgent } from './tui-agent'
import type { CodexInstallationProblem } from './codex-cli-installation'
import type { AgentCliInstallationProblem } from './agent-cli-installation-problem'
import {
  isAgentSessionWireRefusalCode,
  readAgentSessionRefusalReference,
  type AgentSessionOwnerVerdict,
  type AgentSessionRefusalReference,
  type AgentSessionWireRefusal,
  type AgentSessionWireRefusalCode
} from './agent-session-wire-refusals'

/** send retains a Retry card; composer-send returns text to the phone composer; read-history opens without writing. */
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
  /** Saving an edit of a queued message. */
  | 'queued-edit'
  /** A /clear or /compact: refused while the agent works, in words of its own. */
  | 'clear'
  | 'compact'
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
  if (fingerprintMethod === 'agentSession.queuedMessageUpdate') {
    return 'queued-edit'
  }
  if (
    fingerprintMethod === 'agentSession.conversationCommand' &&
    (fields.command === 'clear' || fields.command === 'compact')
  ) {
    return fields.command
  }
  return 'command'
}

/** Persist only facts stable after reload; never moving fences/revisions/resolutions or provider text. */
type DurableRefusalFacts = {
  agent_session_operation_invalid: {
    rewindReason?: AgentSessionRewindReason
    account?: AgentSessionAccountKind
    argumentProblem?: AgentSessionArgumentProblem
    agent?: TuiAgent
    agentInstallation?: AgentCliInstallationProblem
    codexInstallation?: CodexInstallationProblem
  }
  agent_session_operation_unknown: { rewindReason?: AgentSessionRewindReason }
  /** A snapshot from when it was refused; see `agentSessionOwnerVerdictAllowsFreshOperationId`. */
  agent_session_ownership_unknown: { ownerVerdict?: AgentSessionOwnerVerdict }
}

const DURABLE_FACT_KEYS: Partial<Record<AgentSessionWireRefusalCode, readonly string[]>> = {
  agent_session_operation_invalid: [
    'rewindReason',
    'account',
    'argumentProblem',
    'agent',
    'agentInstallation',
    'codexInstallation'
  ],
  agent_session_operation_unknown: ['rewindReason'],
  agent_session_ownership_unknown: ['ownerVerdict']
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

/** Read saved details against code; drop newer reasons/verdicts and retain code wording. */
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

/** Only RPC proof the host refused before method execution proves no write; absent error codes cannot establish this. */
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

/** Read refusal data from thrown RPC response.error or stream error payloads; older hosts/non-refusals yield undefined. */
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

/** Prefer refusal data over RPC code for wording only; callers still decide whether effects may have happened. */
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
