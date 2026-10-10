import { useMemo } from 'react'
import type { AgentSessionRewindResult } from '../../../../shared/agent-session-rewind'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { useStructuredAgentSessionHostRecoversRewindOnSend } from '@/runtime/structured-agent-session-host-capability'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'
import {
  useNativeChatRewind,
  type NativeChatRewindHost,
  type RewindInput
} from './use-native-chat-rewind'

/** The rewind a structured session's user rows offer, sent through the session's own writes. */
export function useStructuredAgentSessionRewind(
  args: Omit<RewindInput, keyof NativeChatRewindHost | 'send'> &
    NativeChatRewindHost & { target: RuntimeClientTarget; write: StructuredAgentSessionWrite }
) {
  const {
    blocked,
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
  // An in-doubt rewind returns the prompt for the next send to settle; only a host that settles it
  // on a send may offer one. Unknown hides it, as unresolved support does.
  const support = useStructuredAgentSessionHostRecoversRewindOnSend(target)
    ? args.support
    : undefined
  const input = useMemo<RewindInput>(
    () => ({
      sessionId,
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
