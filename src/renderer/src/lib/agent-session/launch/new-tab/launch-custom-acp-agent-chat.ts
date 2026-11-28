// Opens a chat with a custom ACP agent: always a chat, since the agent has no terminal program.

import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import { launchStructuredAgentFromNewTab } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab-structured-route'
import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import type { CustomAcpAgentId } from '../../../../../../shared/agent-launch/custom-acp/custom-acp-agent'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { NativeChatComposerFocusIntent } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import type { StructuredLaunchTerminal } from '@/lib/agent-session/launch/structured-agent-session-launch-admission'

export function launchCustomAcpAgentChat(args: {
  agent: CustomAcpAgentId
  worktreeId: string
  executionHostId: ExecutionHostId
  groupId?: string
  focusIntent?: NativeChatComposerFocusIntent
  /** What opens instead when the host declines, such as an empty workspace's shell. */
  onHostDeclined?: () => StructuredLaunchTerminal
}): ReturnType<typeof launchStructuredAgentFromNewTab> {
  const plan = adoptAgentSessionLaunchVerdict({
    route: 'structured-native-chat',
    // A launch with its own fallback, such as an empty workspace's shell, lets a declining host
    // open it; without one, the chat is what was asked for, and a decline is reported as failed.
    ...(args.onHostDeclined ? {} : { requestedSurface: 'chat' as const }),
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
    ...(args.onHostDeclined ? { onHostDeclined: args.onHostDeclined } : {}),
    // The chat itself says why its host declined; there is no terminal to open instead.
    openTerminal: () => ({ refused: { delivered: false, failureNotified: false } })
  })
}
