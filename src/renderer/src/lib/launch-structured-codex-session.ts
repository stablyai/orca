import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'

function newSessionId(): string {
  return `codex_${crypto.randomUUID().replaceAll('-', '_')}`
}

export async function launchStructuredCodexSession(worktreeId: string): Promise<string> {
  const sessionId = newSessionId()
  const fields = { worktree: toRuntimeWorktreeSelector(worktreeId), agent: 'codex' as const }
  const result = await callStructuredAgentSession<
    AgentSessionMutationResult<AgentSessionAttachResult>
  >({ kind: 'local' }, 'agentSession.create', {
    envelope: {
      sessionId,
      clientOperationId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
      expectedRuntimeFence: null,
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId,
        fields
      })
    },
    ...fields
  })
  if (!result.ok) {
    throw new Error(result.refusal.message)
  }
  return result.value.sessionId
}
