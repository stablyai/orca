import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { launchAgentSessionContinuation } from '@/lib/agent-session/launch/continuation/launch-agent-session-continuation'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import {
  buildChatForkRecap,
  type ChatForkRecapScope
} from '../../../../../../../shared/agent-session/conversation-context/chat-fork-recap'
import type { ChatForkSurface } from '../../../../../../../shared/native-chat/chat-fork-path'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { ExecutionHostId } from '../../../../../../../shared/execution-host/execution-host'
import type { NativeChatForkWindowSource } from './native-chat-fork-window-source'

/** The hand-off recap of the chat through the fork point, built here without asking any model;
 *  null (after saying so) when there is nothing to recap. */
export function nativeChatForkRecapPrompt(
  source: NativeChatForkWindowSource,
  throughItemId: string,
  scope: ChatForkRecapScope
): string | null {
  const sourceWorktree = useAppStore.getState().getKnownWorktreeById(source.worktreeId)
  const recap = buildChatForkRecap({
    messages: source.messages(),
    throughItemId,
    scope,
    sourceAgent: source.agent,
    sourceTitle: source.label,
    sourceWorkingDirectory: sourceWorktree?.path ?? null
  })
  if (recap === null) {
    toast.error(
      translate(
        'components.agentSessionContinuation.noContext',
        'No session context is available to continue in a new session.'
      )
    )
  }
  return recap
}

/** Starts `agent` as a chat or in a terminal with a recap of this chat through the fork point staged
 *  unsent (forking never calls a model); your message, when forking from one, follows the recap. */
export async function runNativeChatRecapFork(input: {
  recap: string
  agent: TuiAgent
  hostId: ExecutionHostId
  openAs: ChatForkSurface
  worktreeId: string
  draft?: string
  signal?: AbortSignal
}): Promise<boolean> {
  const { recap } = input
  const worktree = useAppStore.getState().getKnownWorktreeById(input.worktreeId)
  activateAndRevealWorktree(input.worktreeId, { sidebarRevealBehavior: 'auto' })
  return launchAgentSessionContinuation({
    agent: input.agent,
    prompt: input.draft ? `${recap}\n\n${input.draft}` : recap,
    worktreeId: input.worktreeId,
    ...(worktree?.path ? { initialCwd: worktree.path } : {}),
    launchChoice: {
      agent: input.agent,
      route: input.openAs === 'chat' ? 'structured-native-chat' : 'terminal-tui',
      executionHostId: input.hostId,
      requestedSurface: input.openAs
    },
    launchSource: 'native_chat',
    keepPromptUnsent: true,
    ...(input.signal ? { signal: input.signal } : {})
  })
}
