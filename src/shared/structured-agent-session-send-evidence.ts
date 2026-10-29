import type { AgentSessionMutationResult, AgentSessionSendResult } from './agent-session-wire'
import {
  agentSessionRefusalFailure,
  agentSessionRpcErrorFailure,
  readAgentSessionErrorRefusal,
  type AgentSessionWriteFailure
} from './agent-session-write-failure'

/** Synthetic unknown row: ledger holds the ID but journal lost it, so recording is unproved. */
export const STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING = 'durable_send_submission_missing'

export type StructuredAgentSessionSendAnswer =
  | { kind: 'result'; result: AgentSessionMutationResult<AgentSessionSendResult> }
  | { kind: 'thrown'; error: unknown; rpcCode: string | undefined }

export type StructuredAgentSessionSendEvidence =
  /** The host holds the message (a row in any state, or a queued card): it is the host's now. */
  | { kind: 'recorded' }
  /** The host holds nothing under this id and runs nothing for it: the text goes back. */
  | { kind: 'not-recorded'; failure: AgentSessionWriteFailure }
  /** An answer that proves nothing (a lost one included): it may already be in the chat. */
  | { kind: 'uncertain' }

// RPC codes a host answers before it runs the method: nothing under the id was written.
const TURNED_AWAY_RPC_CODES: ReadonlySet<string> = new Set([
  'method_not_found',
  'method_not_supported',
  'invalid_argument',
  'unauthorized'
])

/** Judge this ID’s only send request; no earlier attempt exists to confuse its outcome. */
export function structuredAgentSessionSendEvidence(
  answer: StructuredAgentSessionSendAnswer
): StructuredAgentSessionSendEvidence {
  if (answer.kind === 'thrown') {
    // Only pre-method RPC rejections prove no write; other throws/refusals can occur after recording.
    return answer.rpcCode !== undefined &&
      TURNED_AWAY_RPC_CODES.has(answer.rpcCode) &&
      readAgentSessionErrorRefusal(answer.error) === undefined
      ? { kind: 'not-recorded', failure: agentSessionRpcErrorFailure(answer.rpcCode) }
      : { kind: 'uncertain' }
  }
  const { result } = answer
  if (result.ok) {
    const value: AgentSessionSendResult = result.value
    // Ledger-only synthetic rows cannot prove whether journal recording happened.
    return 'submission' in value &&
      value.submission.reason === STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING
      ? { kind: 'uncertain' }
      : { kind: 'recorded' }
  }
  const failure = agentSessionRefusalFailure(result.refusal)
  // Operation-unknown is ambiguous except rewindUnconfirmed, which proves this send never ran.
  if (failure.kind === 'refused' && failure.code === 'agent_session_operation_unknown') {
    return failure.details?.reason === 'rewindUnconfirmed'
      ? { kind: 'not-recorded', failure }
      : { kind: 'uncertain' }
  }
  // This was the ID’s only request; a definite refusal leaves nothing recorded or running under it.
  return { kind: 'not-recorded', failure }
}
