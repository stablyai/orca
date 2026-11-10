import { useMemo } from 'react'
import type { AgentSessionRewindResult } from '../../../../../../shared/agent-session/lifecycle/agent-session-rewind'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { useStructuredAgentSessionHostRecoversRewindOnSend } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import type { StructuredAgentSessionWrite } from '../../session/structured/writes/use-structured-agent-session-mutate'
import { useNativeChatRewind, type RewindInput } from './use-native-chat-rewind'
import type { NativeChatRewindHost } from './use-native-chat-rewind-host'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { NativeChatCheckpointClient } from './native-chat-rewind-files'
import type {
  AgentSessionCheckpointPreview,
  AgentSessionCheckpointRestoreResult
} from '../../../../../../shared/agent-session/lifecycle/agent-session-checkpoint'

/** A large worktree's restore hashes every file once; don't cut it off mid-write. */
const CHECKPOINT_RESTORE_TIMEOUT_MS = 120_000

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
  const checkpoints = useMemo<NativeChatCheckpointClient>(
    () => ({
      preview: (itemId) =>
        callRuntimeRpc<AgentSessionCheckpointPreview>(target, 'agentSession.checkpointPreview', {
          sessionId,
          itemId
        }),
      restore: (itemId) =>
        callRuntimeRpc<AgentSessionCheckpointRestoreResult>(
          target,
          'agentSession.checkpointRestore',
          { sessionId, itemId },
          { timeoutMs: CHECKPOINT_RESTORE_TIMEOUT_MS }
        ),
      undo: (undoId) =>
        callRuntimeRpc<AgentSessionCheckpointRestoreResult>(
          target,
          'agentSession.checkpointUndo',
          { sessionId, undoId },
          { timeoutMs: CHECKPOINT_RESTORE_TIMEOUT_MS }
        )
    }),
    [sessionId, target]
  )
  const input = useMemo<RewindInput>(
    () => ({
      checkpoints,
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
      checkpoints,
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
