import {
  callStructuredAgentSession,
  supportsStructuredAgentSessionContinuationContext
} from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentSessionContinuationContext } from '../../../../shared/agent-session/agent-session-wire'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { buildAgentSessionHandoffContext } from '../../../../shared/agent-session-handoff-context'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'

export type NativeChatSessionContextSource = {
  target: RuntimeClientTarget
  sessionId: string
  worktreeId: string
  epoch: string
  messages: readonly NativeChatMessage[]
}

export async function resolveNativeChatSessionContext({
  target,
  sessionId,
  worktreeId,
  epoch,
  messages
}: NativeChatSessionContextSource): Promise<{
  capturedText: string
  transcriptPath?: string
} | null> {
  const context = await withTimeout(
    (async () => {
      if (!(await supportsStructuredAgentSessionContinuationContext(target))) {
        return null
      }
      return callStructuredAgentSession<AgentSessionContinuationContext>(
        target,
        'agentSession.continuationContext',
        {
          sessionId,
          workspaceId: worktreeId,
          expectedCursor: { epoch, sequence: 0 }
        }
      )
    })(),
    30_000,
    null
  )
  if (context?.status === 'superseded') {
    return null
  }
  return context?.status === 'current' && typeof context.capturedText === 'string'
    ? { capturedText: context.capturedText, transcriptPath: context.transcriptPath }
    : { capturedText: buildAgentSessionHandoffContext(messages) }
}
