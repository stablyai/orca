// Opens a chat with a custom ACP agent: always a chat, since the agent has no terminal program.

import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import { launchStructuredAgentFromNewTab } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab-structured-route'
import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import type { CustomAcpAgentId } from '../../../../../../shared/agent-launch/custom-acp/custom-acp-agent'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { NativeChatComposerFocusIntent } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'

export function launchCustomAcpAgentChat(args: {
  agent: CustomAcpAgentId
  worktreeId: string
  executionHostId: ExecutionHostId
  groupId?: string
  focusIntent?: NativeChatComposerFocusIntent
}): ReturnType<typeof launchStructuredAgentFromNewTab> {
  const plan = adoptAgentSessionLaunchVerdict({
    route: 'structured-native-chat',
    requestedSurface: 'chat',
    requestId: createNonSecureContextUuid(),
    agent: args.agent,
    worktreeId: args.worktreeId,
    executionHostId: args.executionHostId
  })
  return launchStructuredAgentFromNewTab({
    plan,
    worktreeId: args.worktreeId,
    ...(args.groupId ? { groupId: args.groupId } : {}),
    ...(args.focusIntent ? { focusIntent: args.focusIntent } : {}),
    // The chat itself says why its host declined; there is no terminal to open instead.
    openTerminal: () => ({ refused: { delivered: false, failureNotified: false } })
  })
}
