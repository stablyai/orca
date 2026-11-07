import { useMemo } from 'react'
import { openDesktopStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import {
  NativeChatForkContext,
  NativeChatForkedFromContext,
  NativeChatForkSlotContext
} from './native-chat-fork-context'
import { NativeChatRewindContext } from './native-chat-rewind-context'
import type { NativeChatRewindSurface } from './use-native-chat-rewind'
import type { NativeChatForkSurface } from './use-native-chat-fork'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'

/** What the pane's transcript rows offer: rewind on prompts, fork on responses, and the chat a
 *  "Forked from" divider opens. */
export function NativeChatRowActionsProvider({
  pane,
  chat,
  fork,
  children
}: {
  pane: Pick<NativeChatStructuredViewProps, 'tabId' | 'agent' | 'target'>
  chat: { rewind: { surface: NativeChatRewindSurface | undefined } }
  /** The session's fork, shared with its `/fork` command. */
  fork: NativeChatForkSurface | undefined
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
        <NativeChatForkedFromContext.Provider value={openSource}>
          <NativeChatForkSlotContext.Provider value>{children}</NativeChatForkSlotContext.Provider>
        </NativeChatForkedFromContext.Provider>
      </NativeChatForkContext.Provider>
    </NativeChatRewindContext.Provider>
  )
}
