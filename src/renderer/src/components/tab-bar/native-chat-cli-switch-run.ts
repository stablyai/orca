import { findStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner-registry'
import { runningStructuredAgentSessionTurnId } from '../../../../shared/structured-agent-session-live-turn'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  conversationSwitchChanged,
  pendingNativeChatCliSwitches as pending
} from '@/lib/pending-conversation-surface-switches'
import { conversationSwitchFailureText } from '@/lib/conversation-switch-feedback'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import type { AiVaultAgent } from '../../../../shared/ai-vault-types'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { parseExecutionHostId } from '../../../../shared/execution-host'

const changed = conversationSwitchChanged
/** Moves a chat's conversation into a terminal on the same id: the host proves the chat stopped, the
 *  terminal opens in the chat's slot, then the chat tab closes. `chatTabId` null opens a new tab. */
export async function runLegacyNativeChatCliSwitch(args: {
  sessionId: string
  workspaceId: string
  executionHostId: string
  agent: AiVaultAgent
  chatTabId: string | null
  onComplete?: () => void
  reportFailure?: (error: unknown) => void
}): Promise<void> {
  const key = `${args.executionHostId}\0${args.sessionId}\0legacy`
  const target = structuredAgentSessionTargetForHost(args.executionHostId)
  const hostId = parseExecutionHostId(args.executionHostId)?.id
  if (pending.has(key) || !target || !hostId) {
    return
  }
  pending.set(key, args)
  try {
    changed()
    if (
      getExecutionHostIdForWorktree(useAppStore.getState(), args.workspaceId) !==
      args.executionHostId
    ) {
      throw new Error('source unavailable')
    }
    const supports = async (capability: string) =>
      target.kind === 'local'
        ? (await ensureLocalRuntimeCapabilities())?.includes(capability) === true
        : runtimeEnvironmentSupportsCapability(target.environmentId, capability)
    const held = findStructuredAgentSessionReadOwner(args.sessionId, target)?.getSnapshot()
    if (held?.current && held.state.fence !== null) {
      const conversationStop = await supports(AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY)
      const turnId = runningStructuredAgentSessionTurnId(held.state)
      if (conversationStop || turnId) {
        const fields = conversationStop ? {} : { turnId }
        const stopped = await callStructuredAgentSession<{ ok: boolean }>(
          target,
          'agentSession.cancel',
          {
            envelope: {
              sessionId: args.sessionId,
              clientOperationId: createBrowserUuid(),
              expectedRuntimeFence: held.state.fence,
              payloadFingerprint: structuredAgentSessionPayloadFingerprint({
                method: 'agentSession.cancel',
                sessionId: args.sessionId,
                fields
              })
            },
            ...fields
          }
        )
        if (!stopped.ok) {
          throw agentSessionRefusalError('agent_session_ownership_unknown', {
            reason: 'ownerUnproven'
          })
        }
      }
    }
    // Ordinary old Close has no positive exit receipt; keep readable recovery without launching.
    try {
      await callStructuredAgentSession(target, 'agentSession.close', { sessionId: args.sessionId })
    } finally {
      await callStructuredAgentSession(target, 'agentSession.reveal', {
        sessionId: args.sessionId
      }).catch(() => {})
    }
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' })
  } catch (error) {
    if (args.reportFailure) {
      args.reportFailure(error)
    } else {
      toast.error(
        conversationSwitchFailureText(error, { agent: args.agent, direction: 'terminal' })
      )
    }
  } finally {
    pending.delete(key)
    try {
      useAppStore.setState((state) => ({
        agentConversationsByPaneKey: state.agentConversationsByPaneKey
      }))
    } finally {
      try {
        changed()
      } finally {
        args.onComplete?.()
      }
    }
  }
}
