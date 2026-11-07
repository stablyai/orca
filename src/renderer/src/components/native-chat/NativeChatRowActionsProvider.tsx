import { useMemo } from 'react'
import { openDesktopStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import {
  NativeChatForkContext,
  NativeChatForkedFromContext,
  NativeChatForkSlotContext,
  NativeChatSideChatForkPointContext
} from './native-chat-fork-context'
import { NativeChatRewindContext } from './native-chat-rewind-context'
import type { NativeChatRewindSurface } from './use-native-chat-rewind'
import type { NativeChatForkSurface } from './use-native-chat-fork'
import type { NativeChatSideChat } from './use-native-chat-side-chat'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'

/** What the pane's transcript rows offer: rewind on prompts, fork on responses, and the chat a
 *  "Forked from" divider opens. */
export function NativeChatRowActionsProvider({
  pane,
  chat,
  fork,
  sideChat,
  children
}: {
  pane: Pick<NativeChatStructuredViewProps, 'tabId' | 'agent' | 'target'>
  chat: { rewind: { surface: NativeChatRewindSurface | undefined } }
  /** The session's fork, shared with its `/fork` and `/btw` commands. */
  fork: NativeChatForkSurface | undefined
  sideChat: NativeChatSideChat | undefined
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
      <NativeChatForkContext.Provider value={fork}>
        <NativeChatSideChatForkPointContext.Provider value={sideChat?.reportForkPoint}>
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
