import { NativeChatForkContext, NativeChatForkSlotContext } from './native-chat-fork-context'
import { NativeChatWorktreeForkDialogHost } from './NativeChatWorktreeForkDialog'
import { useNativeChatWorktreeForkRequest } from './native-chat-worktree-fork-requests'
import { useNativeChatTerminalFork } from './use-native-chat-terminal-fork'
import { useNativeChatTabOwnerWorktreeId } from '@/components/native-chat/pane/ownership/use-native-chat-tab-owner'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

/** Gives a terminal chat's rows the same Fork as a chat session, through the CLI's own resume. */
export function NativeChatTerminalForkProvider({
  agent,
  sessionId,
  transcriptPath,
  terminalTabId,
  messages,
  children
}: {
  agent: string
  sessionId: string | null
  transcriptPath: string | null
  terminalTabId: string
  messages: readonly NativeChatMessage[]
  children: React.ReactNode
}): React.JSX.Element {
  const worktreeId = useNativeChatTabOwnerWorktreeId(terminalTabId)
  const target = useWorktreeRuntimeTarget(worktreeId)
  const fork = useNativeChatTerminalFork({
    agent,
    source:
      sessionId && transcriptPath && worktreeId ? { sessionId, transcriptPath, worktreeId } : null,
    messages
  })
  useNativeChatWorktreeForkRequest(terminalTabId, fork?.openWorktreeForkLatest)
  return (
    <NativeChatForkContext.Provider value={fork}>
      <NativeChatForkSlotContext.Provider value={fork !== undefined}>
        {children}
        {fork && worktreeId ? (
          <NativeChatWorktreeForkDialogHost
            dialog={fork.worktreeForkDialog}
            sourceWorktreeId={worktreeId}
            agent="claude"
            request={fork.request}
            source={{
              target: target ?? { kind: 'local' },
              sessionId: sessionId ?? '',
              label: agent
            }}
          />
        ) : null}
      </NativeChatForkSlotContext.Provider>
    </NativeChatForkContext.Provider>
  )
}
