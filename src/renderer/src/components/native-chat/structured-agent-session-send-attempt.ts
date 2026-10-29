// Only agentSession.send mutates; stops during earlier local/read-only work prove the request never went out.

import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import {
  AGENT_SESSION_MESSAGE_TOO_LARGE_PARTS,
  agentSessionWriteNoticeParts,
  agentSessionWriteNotDoneParts
} from '../../../../shared/agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from '../../../../shared/agent-session-write-notice-copy'
import { structuredAgentSessionMessageSendMutation } from '../../../../shared/structured-agent-session-send-mutation'
import { structuredAgentSessionBlocksTooLarge } from '../../../../shared/rpc-contract/structured-agent-session-message-params'
import {
  structuredAgentSessionSendEvidence,
  type StructuredAgentSessionSendAnswer,
  type StructuredAgentSessionSendEvidence
} from '../../../../shared/structured-agent-session-send-evidence'
import { ensureRuntimeEnvironmentCompatible } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import {
  agentSessionThrownFailure,
  readAgentSessionErrorRefusal,
  type AgentSessionWriteFailure
} from '../../../../shared/agent-session-write-failure'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

const fences = new Map<string, number>()

export function noteStructuredAgentSessionFence(sessionId: string, fence: number | null): void {
  if (fence !== null) {
    fences.set(sessionId, fence)
  }
}

export function forgetStructuredAgentSessionFence(sessionId: string): void {
  fences.delete(sessionId)
}

export function resetStructuredAgentSessionFencesForTests(): void {
  fences.clear()
}

async function knownFence(target: RuntimeClientTarget, sessionId: string): Promise<number | null> {
  const known = fences.get(sessionId)
  if (known !== undefined) {
    return known
  }
  // Current hosts ignore it; an older host checks it, so read the one it serves now.
  const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    target,
    'agentSession.history',
    { sessionId, direction: 'tail', limit: 1 }
  )
  const fence = history.page.fence ?? (!history.ok ? history.fence : undefined)
  if (typeof fence !== 'number') {
    return null
  }
  fences.set(sessionId, fence)
  return fence
}

export type StructuredAgentSessionSendAttempt =
  | {
      kind: 'answered'
      evidence: StructuredAgentSessionSendEvidence
      submission: AgentJournalSubmission | null
      cursor: AgentJournalCursor | null
      /** The refusal a thrown answer carried: what the host said, though it proves nothing. */
      thrownRefusal: AgentSessionWriteFailure | null
    }
  /** It failed before its request went out, so nothing was sent: why, in the composer's words. */
  | { kind: 'not-sent'; parts: AgentSessionWriteNoticePart[] }

const NOT_SENT = agentSessionWriteNotDoneParts('composer-send')

/** The code a remote call gets when its environment's pairing or identity changed under it. */
const RUNTIME_ENVIRONMENT_CHANGED = 'runtime_environment_changed'

/** Explain pre-request compatibility blocks, host refusals or lost contact as not sent. */
function notSentParts(error: unknown): AgentSessionWriteNoticePart[] {
  if (isRuntimeCompatBlockError(error) && error instanceof Error) {
    return [{ text: error.message }, 'notDoneSend']
  }
  const rpcCode = error instanceof RuntimeRpcCallError ? error.code : undefined
  return readAgentSessionErrorRefusal(error)
    ? agentSessionWriteNoticeParts(agentSessionThrownFailure(error, rpcCode), 'composer-send')
    : ['unreachable', ...NOT_SENT]
}

/** Null when the send was abandoned (a Stop, its deadline, the journal settling it) meanwhile. */
export async function attemptStructuredAgentSessionSend(args: {
  entry: StructuredAgentSessionPendingSend
  target: RuntimeClientTarget
  beforeIssue: () => void
  abandoned: () => boolean
  reconcile: (uncertain: boolean) => void
}): Promise<StructuredAgentSessionSendAttempt | null> {
  const { entry, target } = args
  // Measured as the host measures it, so a message it would refuse comes back saying why.
  if (structuredAgentSessionBlocksTooLarge(entry.body.blocks)) {
    return { kind: 'not-sent', parts: [...AGENT_SESSION_MESSAGE_TOO_LARGE_PARTS] }
  }
  let fence: number | null
  try {
    if (target.kind === 'environment') {
      await ensureRuntimeEnvironmentCompatible(target.environmentId)
    }
    fence = await knownFence(target, entry.sessionId)
  } catch (error) {
    return args.abandoned() ? null : { kind: 'not-sent', parts: notSentParts(error) }
  }
  if (args.abandoned()) {
    return null
  }
  if (fence === null) {
    return { kind: 'not-sent', parts: NOT_SENT }
  }
  args.beforeIssue()
  const params = structuredAgentSessionMessageSendMutation({
    sessionId: entry.sessionId,
    clientOperationId: entry.clientMessageId,
    expectedRuntimeFence: fence,
    body: entry.body,
    ...(entry.delivery ? { delivery: entry.delivery } : {}),
    ...(entry.options ? { options: entry.options } : {}),
    ...(entry.usageLimitContinuationOfTurnItemId
      ? { usageLimitContinuationOfTurnItemId: entry.usageLimitContinuationOfTurnItemId }
      : {})
  })
  type SendAnswer = AgentSessionMutationResult<AgentSessionSendResult>
  let answer: StructuredAgentSessionSendAnswer
  try {
    const result =
      target.kind === 'environment'
        ? await callStructuredAgentSession<SendAnswer>(target, 'agentSession.send', params, {
            skipCompatibilityCheck: true
          })
        : await callStructuredAgentSession<SendAnswer>(target, 'agentSession.send', params)
    answer = { kind: 'result', result }
  } catch (error) {
    // Re-pairing errors are raised before forwarding, proving the request never went out.
    if (error instanceof RuntimeRpcCallError && error.code === RUNTIME_ENVIRONMENT_CHANGED) {
      args.reconcile(false)
      return args.abandoned() ? null : { kind: 'not-sent', parts: notSentParts(error) }
    }
    answer = {
      kind: 'thrown',
      error,
      rpcCode: error instanceof RuntimeRpcCallError ? error.code : undefined
    }
  }
  args.reconcile(structuredAgentSessionSendEvidence(answer).kind === 'uncertain')
  if (args.abandoned()) {
    return null
  }
  const value = answer.kind === 'result' && answer.result.ok ? answer.result.value : null
  return {
    kind: 'answered',
    evidence: structuredAgentSessionSendEvidence(answer),
    submission: value && 'submission' in value ? value.submission : null,
    cursor: answer.kind === 'result' && answer.result.ok ? answer.result.cursor : null,
    thrownRefusal:
      answer.kind === 'thrown' && readAgentSessionErrorRefusal(answer.error)
        ? agentSessionThrownFailure(answer.error, answer.rpcCode)
        : null
  }
}
