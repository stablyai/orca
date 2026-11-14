import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { launchAgentSessionContinuation } from '@/lib/agent-session/launch/continuation/launch-agent-session-continuation'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { buildAgentSessionContinuationPrompt } from '../../../../../../../shared/agent-session/context/agent-session-continuation'
import { buildAgentSessionHandoffContext } from '../../../../../../../shared/agent-session-handoff-context'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import { nativeChatForkRecapMessages } from './native-chat-fork-window-choices'
import type { NativeChatForkWindowSource } from './native-chat-fork-window-source'

/** The hand-off recap of the chat through the fork point, built here without asking any model. */
export function nativeChatForkRecapPrompt(
  source: NativeChatForkWindowSource,
  throughItemId: string
): string | null {
  const messages = nativeChatForkRecapMessages(source.messages(), throughItemId)
  if (!messages) {
    return null
  }
  const sourceWorktree = useAppStore.getState().getKnownWorktreeById(source.worktreeId)
  return buildAgentSessionContinuationPrompt(
    {
      sourceKind: 'chat',
      sourceAgent: source.agent,
      sourceTitle: source.label,
      sourceWorkingDirectory: sourceWorktree?.path ?? null,
      capturedText: buildAgentSessionHandoffContext(messages)
    },
    'focused'
  )
}

/** Starts `agent` in the workspace with a recap of this chat through the fork point as its first
 *  message. Your message, when forking from one, follows the recap and stays unsent. */
export async function runNativeChatRecapFork(input: {
  source: NativeChatForkWindowSource
  throughItemId: string
  agent: TuiAgent
  worktreeId: string
  draft?: string
  signal?: AbortSignal
}): Promise<boolean> {
  const recap = nativeChatForkRecapPrompt(input.source, input.throughItemId)
  if (!recap) {
    toast.error(
      translate(
        'components.agentSessionContinuation.noContext',
        'No session context is available to continue in a new session.'
      )
    )
    return false
  }
  const worktree = useAppStore.getState().getKnownWorktreeById(input.worktreeId)
  activateAndRevealWorktree(input.worktreeId, { sidebarRevealBehavior: 'auto' })
  return launchAgentSessionContinuation({
    agent: input.agent,
    prompt: input.draft ? `${recap}\n\n${input.draft}` : recap,
    worktreeId: input.worktreeId,
    ...(worktree?.path ? { initialCwd: worktree.path } : {}),
    launchSource: 'native_chat',
    ...(input.draft ? { keepPromptUnsent: true } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  })
}
