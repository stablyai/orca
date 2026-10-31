import { useCallback, useMemo } from 'react'
import {
  useAgentMessageSenderSource,
  useLeasedSenderSelector
} from './native-chat-agent-message-sender-source'
import type { AppState } from '@/store/types'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  agentMessageSenderOpens,
  resolveAgentMessageSenderTarget
} from './native-chat-agent-message-sender-target'
import { agentMessageSavedKind } from '../../../../shared/agent-session/agent-message-presentation'

/** The card's sender, rebuilt only from the fields resolution reads, and where it runs now. */
function useSenderLocation(
  sender: AgentMessageSender | undefined,
  chatWorktreeId: string | null,
  target: RuntimeClientTarget | undefined,
  dispatchId: string | undefined
) {
  const address = sender?.party.address
  const sessionId = sender?.party.orcaSessionId
  const handle = sender?.party.terminalHandle
  const savedAgent = agentMessageSavedKind(sender)
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
  const identity = useMemo<AgentMessageSender | undefined>(
    () =>
      address
        ? {
            party: { address, orcaSessionId: sessionId ?? null, terminalHandle: handle ?? null },
            name: null,
            ...(savedAgent ? { agent: savedAgent } : {})
          }
        : undefined,
    [address, sessionId, handle, savedAgent]
  )
  const resolve = useCallback(
    (state: AppState) =>
      identity
        ? resolveAgentMessageSenderTarget(state, identity, chatWorktreeId, stableTarget, dispatchId)
        : undefined,
    [identity, chatWorktreeId, stableTarget, dispatchId]
  )
  const locate = useCallback(
    (state: AppState) => {
      const resolved = resolve(state)
      if (resolved?.kind === 'legacy') {
        return resolved.location
      }
      const located = resolved?.kind === 'located' ? resolved.location : undefined
      // A located chat's own tab names its agent for cards saved before the agent kind was.
      return located && { ...located, agentType: located.tab?.agentSessionAgent }
    },
    [resolve]
  )
  return { identity, savedAgent, resolve, locate }
}

export function useAgentMessageSenderView(
  sender: AgentMessageSender | undefined,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget,
  dispatchId?: string
) {
  const { savedAgent, locate } = useSenderLocation(sender, chatWorktreeId, target, dispatchId)
  return useAgentMessageSenderSource(locate, savedAgent)
}

/** Whether the card's sender name is a link. Its kind check reads the located row, so it holds
 *  the same lease the avatar does: a name drawn without an avatar rebuilds no rows per write. */
export function useAgentMessageSenderOpens(
  sender: AgentMessageSender,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget,
  dispatchId?: string
): boolean {
  const { identity, resolve, locate } = useSenderLocation(
    sender,
    chatWorktreeId,
    target,
    dispatchId
  )
  const opens = useCallback(
    (state: AppState) => {
      const resolved = resolve(state)
      return Boolean(resolved && identity && agentMessageSenderOpens(resolved, identity))
    },
    [resolve, identity]
  )
  return useLeasedSenderSelector(locate, opens)
}
