import type {
  AgentSessionHistoryResult,
  AgentSessionMutationResult
} from '../../../../shared/agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../../shared/structured-agent-session-mutation'
import { activeStructuredAgentSessionTurnId } from '../../../../shared/structured-agent-session-projection'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

export async function respondToRoomPrompt(
  target: RuntimeClientTarget,
  sessionId: string,
  kind: 'approval' | 'question',
  itemId: string,
  expectedRevision: number,
  optionId: string
): Promise<void> {
  const history = await structuredRoomHistory(target, sessionId)
  const fields = { itemId, expectedRevision, optionId }
  const result = await callStructuredAgentSession<AgentSessionMutationResult<unknown>>(
    target,
    kind === 'approval' ? 'agentSession.respondToApproval' : 'agentSession.respondToQuestion',
    {
      envelope: roomMutationEnvelope(
        sessionId,
        history.page.fence ?? null,
        `agentSession.respondTo:${kind}`,
        fields
      ),
      ...fields
    }
  )
  if (!result.ok) {
    throw new Error(result.refusal.message)
  }
}

export async function cancelRoomStructuredTurn(
  target: RuntimeClientTarget,
  sessionId: string
): Promise<void> {
  const history = await structuredRoomHistory(target, sessionId)
  const turnId = activeStructuredAgentSessionTurnId(history.page.items)
  if (!turnId) {
    return
  }
  const fields = { turnId }
  const result = await callStructuredAgentSession<AgentSessionMutationResult<unknown>>(
    target,
    'agentSession.cancel',
    {
      envelope: roomMutationEnvelope(
        sessionId,
        history.page.fence ?? null,
        'agentSession.cancel',
        fields
      ),
      ...fields
    }
  )
  if (!result.ok) {
    throw new Error(result.refusal.message)
  }
}

function structuredRoomHistory(
  target: RuntimeClientTarget,
  sessionId: string
): Promise<AgentSessionHistoryResult> {
  return callStructuredAgentSession(target, 'agentSession.history', {
    sessionId,
    direction: 'tail',
    limit: 200
  })
}

function roomMutationEnvelope(
  sessionId: string,
  fence: number | null,
  method: string,
  fields: Record<string, unknown>
) {
  return {
    sessionId,
    clientOperationId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
    expectedRuntimeFence: fence,
    payloadFingerprint: structuredAgentSessionPayloadFingerprint({ method, sessionId, fields })
  }
}
