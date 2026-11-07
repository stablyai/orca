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
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'

/** What the pane's transcript rows offer: rewind on prompts, fork on responses, and the chat a
 *  "Forked from" divider opens. */
export function NativeChatRowActionsProvider({
  pane,
  chat,
  actions,
  children
}: {
  pane: Pick<NativeChatStructuredViewProps, 'tabId' | 'agent' | 'target'>
  chat: { rewind: { surface: NativeChatRewindSurface | undefined } }
  /** The composer's fork and `/btw`, which share it. */
  actions: Pick<NativeChatStructuredComposerTransport, 'fork' | 'sideChat'>
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
      <NativeChatForkContext.Provider value={actions.fork}>
        <NativeChatSideChatForkPointContext.Provider value={actions.sideChat?.reportForkPoint}>
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
