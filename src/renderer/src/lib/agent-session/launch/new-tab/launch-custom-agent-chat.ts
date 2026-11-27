import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import type { CustomAcpAgentId } from '../../../../../../shared/agent-launch/custom-acp/custom-acp-agents'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { adoptAgentSessionLaunchVerdict } from '../routing/agent-session-launch-plan'
import { launchStructuredAgentFromNewTab } from './launch-agent-in-new-tab-structured-route'

/** Opens a chat with one of the host's custom ACP agents; with no CLI behind it, a refusal stays in the chat.
 *  Returns the new chat tab's id, or null when it did not open here. */
export function launchCustomAgentChat(args: {
  agent: CustomAcpAgentId
  worktreeId: string
  groupId?: string
  executionHostId?: ExecutionHostId
}): string | null {
  const plan = adoptAgentSessionLaunchVerdict({
    route: 'structured-native-chat',
    requestedSurface: 'chat',
    requestId: createNonSecureContextUuid(),
    agent: args.agent,
    worktreeId: args.worktreeId,
    ...(args.executionHostId ? { executionHostId: args.executionHostId } : {})
  })
  const launch = launchStructuredAgentFromNewTab({
    plan,
    worktreeId: args.worktreeId,
    focusIntent: captureNativeChatComposerFocusIntent(),
    ...(args.groupId ? { groupId: args.groupId } : {}),
    openTerminal: () => ({ refused: { delivered: false, failureNotified: true } })
  })
  if (!launch || 'refused' in launch) {
    return null
  }
  return launch.surface.kind === 'local-chat' ? launch.surface.tabId : null
}
