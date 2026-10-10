import type { AgentSessionCancelResult } from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { supportsStructuredAgentSessionPromptCancel } from '@/runtime/structured-agent-session-client'
import { useStructuredAgentSessionHostCapability } from '@/runtime/structured-agent-session-host-capability'
import { AGENT_SESSION_TARGETED_STOP_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { agentSessionStopTarget } from '../../../../shared/agent-session-stop-target'
import { agentSessionBackgroundStopTarget } from '../../../../shared/agent-session-background-stop-target'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import type { useStructuredAgentSessionTransportState } from './use-structured-agent-session-transport-state'

export function useStructuredAgentSessionCancel(input: {
  target: RuntimeClientTarget
  transportState: Pick<
    ReturnType<typeof useStructuredAgentSessionTransportState>,
    'submissions' | 'fence' | 'backgroundTasks'
  >
  mutate: StructuredAgentSessionMutate
}) {
  const { target, transportState, mutate } = input
  const targetedStop = useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_TARGETED_STOP_RUNTIME_CAPABILITY
  )
  return {
    cancel: async (
      turnId: string | undefined,
      prompt?: { itemId: string; expectedRevision: number }
    ) => {
      const stopTarget = agentSessionStopTarget(
        turnId ?? null,
        transportState.submissions,
        transportState.fence
      )
      const promptSupported =
        prompt !== undefined && (await supportsStructuredAgentSessionPromptCancel(target))
      return mutate('agentSession.cancel', 'agentSession.cancel', {
        ...(turnId ? { turnId } : {}),
        ...(stopTarget && targetedStop ? { stopTarget } : {}),
        ...(promptSupported ? { prompt } : {})
      })
    },
    stopBackgroundTask: (taskId?: string) => {
      const stopTarget = agentSessionBackgroundStopTarget(
        transportState.backgroundTasks.children,
        taskId
      )
      return mutate<AgentSessionCancelResult>('agentSession.cancel', 'agentSession.cancel', {
        turnId: 'background-tasks',
        scope: 'background-tasks',
        ...(taskId ? { taskId } : {}),
        ...(targetedStop ? { stopTarget } : {})
      })
    }
  }
}
