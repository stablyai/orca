import { useMemo } from 'react'
import type { AgentSessionRewindResult } from '../../../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { useStructuredAgentSessionHostRecoversRewindOnSend } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import type { StructuredAgentSessionWrite } from '../../session/structured/writes/use-structured-agent-session-mutate'
import { useNativeChatRewind, type RewindInput } from './use-native-chat-rewind'
import type { NativeChatRewindHost } from './use-native-chat-rewind-host'

/** The rewind a structured session's user rows offer, sent through the session's own writes. */
export function useStructuredAgentSessionRewind(
  args: Omit<RewindInput, keyof NativeChatRewindHost | 'send'> &
    NativeChatRewindHost & { target: RuntimeClientTarget; write: StructuredAgentSessionWrite }
) {
  const {
    blocked,
    capturePresentation,
    composerScopeKey,
    contextFloor,
    hostBlockedReason,
    isVisible,
    onMessageReturned,
    sessionId,
    state,
    target,
    write
  } = args
  // Offer rewind only when the host can settle an uncertain result on the next send; unknown capability must hide it.
  const support = useStructuredAgentSessionHostRecoversRewindOnSend(target)
    ? args.support
    : undefined
  const input = useMemo<RewindInput>(
    () => ({
      sessionId,
      capturePresentation,
      composerScopeKey,
      contextFloor,
      onMessageReturned,
      isVisible,
      hostBlockedReason: hostBlockedReason ?? undefined,
      state,
      support,
      blocked,
      send: (fields) =>
        write<AgentSessionRewindResult>('agentSession.rewind', 'agentSession.rewind', fields)
    }),
    [
      blocked,
      capturePresentation,
      composerScopeKey,
      contextFloor,
      hostBlockedReason,
      isVisible,
      onMessageReturned,
      sessionId,
      state,
      support,
      write
    ]
  )
  return useNativeChatRewind(input)
}
