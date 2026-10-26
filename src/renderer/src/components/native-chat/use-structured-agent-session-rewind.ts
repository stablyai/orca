import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RewindFilesPreview } from '../../../../shared/agent-session-rewind-files'
import { useMemo } from 'react'
import type { AgentSessionRewindResult } from '../../../../shared/agent-session-rewind'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useStructuredAgentSessionHostRecoversRewindOnSend } from '@/runtime/structured-agent-session-host-capability'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'
import {
  useNativeChatRewind,
  type NativeChatRewindHost,
  type RewindInput
} from './use-native-chat-rewind'

/** The rewind a structured session's user rows offer, sent through the session's own writes. */
export function useStructuredAgentSessionRewind(
  args: Omit<RewindInput, keyof NativeChatRewindHost | 'send' | 'previewFiles'> &
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
      previewFiles: (fields) =>
        callRuntimeRpc<RewindFilesPreview>(target, 'agentSession.rewindFilesPreview', {
          sessionId,
          ...fields
        }),
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
      target,
      write
    ]
  )
  return useNativeChatRewind(input)
}
