import { normalizeAgentSessionConversationName } from '../../../../../shared/agent-session/conversation-naming/agent-session-conversation-name'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { supportsStructuredAgentSessionRename } from '../host-capabilities/structured-agent-session-host-support'
import { structuredAgentSessionTargetForHost } from '../session-ownership/structured-agent-session-owner'

/** Saves the name picked for a new fork as the chat's own user name on its host; a host that can't
 *  store names keeps the fork's default one. */
export async function nameForkedStructuredChat(
  executionHostId: string,
  sessionId: string,
  name: string
): Promise<void> {
  const normalized = normalizeAgentSessionConversationName(name)
  const target = structuredAgentSessionTargetForHost(executionHostId)
  if (!normalized || !target) {
    return
  }
  try {
    if (await supportsStructuredAgentSessionRename(target)) {
      await callRuntimeRpc(target, 'agentSession.rename', { sessionId, name: normalized })
    }
  } catch (error) {
    console.warn('[structured-chat-fork-name] naming the fork failed', error)
  }
}
