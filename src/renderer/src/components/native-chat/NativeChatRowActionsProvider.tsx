import { useMemo } from 'react'
import { openDesktopStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import { NativeChatForkContext, NativeChatForkedFromContext } from './native-chat-fork-context'
import { NativeChatRewindContext } from './native-chat-rewind-context'
import type { NativeChatRewindSurface } from './use-native-chat-rewind'
import { useNativeChatFork } from './use-native-chat-fork'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'

/** What the pane's transcript rows offer: rewind on prompts, fork on responses, and the chat a
 *  "Forked from" divider opens. */
export function NativeChatRowActionsProvider({
  pane,
  chat,
  children
}: {
  pane: Pick<NativeChatStructuredViewProps, 'sessionId' | 'tabId' | 'agent' | 'target'>
  chat: {
    rewind: { surface: NativeChatRewindSurface | undefined }
    journalItems: readonly AgentJournalRenderItem[]
    epoch: string | null
    contextFloor: AgentJournalCursor | undefined
  }
  children: React.ReactNode
}): React.JSX.Element {
  const worktreeId = useNativeChatTabOwnerWorktreeId(pane.tabId)
  const fork = useNativeChatFork({
    sessionId: pane.sessionId,
    tabId: pane.tabId,
    agent: pane.agent,
    target: pane.target,
    worktreeId,
    items: chat.journalItems,
    epoch: chat.epoch,
    contextFloor: chat.contextFloor
  })
  const { agent, target } = pane
  // A fork and its source share a workspace and host.
  const openSource = useMemo(
    () =>
      worktreeId
        ? (sourceSessionId: string) =>
            void openDesktopStructuredSession(
              {
                kind: 'history',
                structuredSession: { sessionId: sourceSessionId, workspaceId: worktreeId },
                agent
              },
              target
            )
        : undefined,
    [agent, target, worktreeId]
  )
  return (
    <NativeChatRewindContext.Provider value={chat.rewind.surface}>
      <NativeChatForkContext.Provider value={fork}>
        <NativeChatForkedFromContext.Provider value={openSource}>
          {children}
        </NativeChatForkedFromContext.Provider>
      </NativeChatForkContext.Provider>
    </NativeChatRewindContext.Provider>
  )
}
