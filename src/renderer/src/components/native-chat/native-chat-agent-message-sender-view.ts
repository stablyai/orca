import { useCallback, useMemo } from 'react'
import { useAgentMessageSenderSource } from './native-chat-agent-message-sender-source'
import type { AppState } from '@/store/types'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { resolveAgentMessageSenderTarget } from './native-chat-agent-message-sender-target'

export function useAgentMessageSenderView(
  sender: AgentMessageSender | undefined,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget,
  dispatchId?: string
) {
  const address = sender?.party.address
  const sessionId = sender?.party.orcaSessionId
  const handle = sender?.party.terminalHandle
  const savedAgent = sender?.agent
  const targetKind = target?.kind
  const environmentId = target?.kind === 'environment' ? target.environmentId : undefined
  const stableTarget = useMemo<RuntimeClientTarget | undefined>(
    () =>
      targetKind === 'local'
        ? { kind: 'local' }
        : environmentId !== undefined
          ? { kind: 'environment', environmentId }
          : undefined,
    [targetKind, environmentId]
  )
  const locate = useCallback(
    (state: AppState) => {
      if (!address) {
        return undefined
      }
      const identity = {
        party: { address, orcaSessionId: sessionId ?? null, terminalHandle: handle ?? null },
        name: null,
        ...(savedAgent ? { agent: savedAgent } : {})
      }
      const resolved = resolveAgentMessageSenderTarget(
        state,
        identity,
        chatWorktreeId,
        stableTarget,
        dispatchId
      )
      if (resolved.kind === 'legacy') {
        return resolved.location
      }
      const located = resolved.kind === 'located' ? resolved.location : undefined
      // A located chat's own tab names its agent for cards saved before the agent kind was.
      return located && { ...located, agentType: located.tab?.agentSessionAgent }
    },
    [address, sessionId, handle, savedAgent, chatWorktreeId, stableTarget, dispatchId]
  )
  return useAgentMessageSenderSource(locate, sender?.agent)
}
