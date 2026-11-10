import { useMemo } from 'react'
import { openDesktopStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import type { NativeChatStructuredViewProps } from '@/components/native-chat/native-chat-view-types'
import {
  NativeChatForkContext,
  NativeChatForkedFromContext,
  NativeChatForkSlotContext,
  NativeChatSideChatForkPointContext
} from '@/components/native-chat/messages/actions/native-chat-fork-context'
import { NativeChatRewindContext } from '@/components/native-chat/messages/actions/native-chat-rewind-context'
import type { NativeChatRewindSurface } from '@/components/native-chat/messages/actions/use-native-chat-rewind-host'
import type { NativeChatPaneForks } from '@/components/native-chat/messages/actions/use-native-chat-fork'
import { useNativeChatTabOwnerWorktreeId } from '@/components/native-chat/pane/ownership/use-native-chat-tab-owner'

/** What the pane's transcript rows offer: rewind on prompts, fork on responses, and the chat a
 *  "Forked from" divider opens. */
export function NativeChatRowActionsProvider({
  pane,
  chat,
  forks,
  children
}: {
  pane: Pick<NativeChatStructuredViewProps, 'tabId' | 'agent' | 'target'>
  chat: { rewind: { surface: NativeChatRewindSurface | undefined } }
  /** The session's fork, shared with its `/fork` and `/btw` commands. */
  forks: NativeChatPaneForks
  children: React.ReactNode
}): React.JSX.Element {
  const worktreeId = useNativeChatTabOwnerWorktreeId(pane.tabId)
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
      <NativeChatForkContext.Provider value={forks.fork}>
        <NativeChatSideChatForkPointContext.Provider value={forks.sideChat?.reportForkPoint}>
          <NativeChatForkedFromContext.Provider value={openSource}>
            <NativeChatForkSlotContext.Provider value>
              {children}
            </NativeChatForkSlotContext.Provider>
          </NativeChatForkedFromContext.Provider>
        </NativeChatSideChatForkPointContext.Provider>
      </NativeChatForkContext.Provider>
    </NativeChatRewindContext.Provider>
  )
}
