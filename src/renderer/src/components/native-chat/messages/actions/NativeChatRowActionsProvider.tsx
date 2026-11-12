import { useMemo } from 'react'
import { openDesktopStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import {
  NativeChatForkContext,
  NativeChatForkedFromContext,
  NativeChatForkSlotContext,
  NativeChatSideChatForkPointContext
} from '@/components/native-chat/messages/actions/native-chat-fork-context'
import { NativeChatRewindContext } from '@/components/native-chat/messages/actions/native-chat-rewind-context'
import { useNativeChatTabOwnerWorktreeId } from '@/components/native-chat/pane/ownership/use-native-chat-tab-owner'
import type { NativeChatStructuredViewProps } from '@/components/native-chat/native-chat-view-types'
import type { NativeChatRewindSurface } from '@/components/native-chat/messages/actions/use-native-chat-rewind-host'
import type { NativeChatPaneForks } from '@/components/native-chat/messages/actions/use-native-chat-fork'
import { useAppStore } from '@/store'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import { NativeChatWorktreeForkDialogHost } from './NativeChatWorktreeForkDialog'
import { useNativeChatWorktreeForkRequest } from './native-chat-worktree-fork-requests'

/** The chat tab's title, as a subagent addresses its report. */
function chatTabLabel(tabId: string, worktreeId: string): string | undefined {
  const tab = useAppStore
    .getState()
    .unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === tabId)
  return tab ? tab.customLabel || tab.label || undefined : undefined
}

/** The workspace showing a chat's tab; a fork into a new worktree lives apart from its source. */
function openChatWorkspaceId(sessionId: string, fallback: string): string {
  const tabs = Object.values(useAppStore.getState().unifiedTabsByWorktree).flat()
  return (
    tabs.find((tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId)
      ?.worktreeId ?? fallback
  )
}

/** What the pane's transcript rows offer: rewind on prompts, fork on responses, and the chat a
 *  "Forked from" divider opens. */
export function NativeChatRowActionsProvider({
  pane,
  chat,
  forks,
  children
}: {
  pane: Pick<NativeChatStructuredViewProps, 'tabId' | 'agent' | 'target' | 'sessionId'>
  chat: { rewind: { surface: NativeChatRewindSurface | undefined } }
  /** The session's fork, shared with its `/fork` and `/btw` commands. */
  forks: NativeChatPaneForks
  children: React.ReactNode
}): React.JSX.Element {
  const worktreeId = useNativeChatTabOwnerWorktreeId(pane.tabId)
  const { agent, target } = pane
  useNativeChatWorktreeForkRequest(pane.tabId, forks.fork?.openWorktreeForkLatest)
  // A fork and its source share a host; a fork into a new worktree has its source open elsewhere.
  const openSource = useMemo(
    () =>
      worktreeId
        ? (sourceSessionId: string) =>
            void openDesktopStructuredSession(
              {
                kind: 'history',
                structuredSession: {
                  sessionId: sourceSessionId,
                  workspaceId: openChatWorkspaceId(sourceSessionId, worktreeId)
                },
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
              {forks.fork && worktreeId && isTuiAgent(agent) ? (
                <NativeChatWorktreeForkDialogHost
                  dialog={forks.fork.worktreeForkDialog}
                  sourceWorktreeId={worktreeId}
                  agent={agent}
                  request={forks.fork.request}
                  source={{
                    target,
                    sessionId: pane.sessionId,
                    label: chatTabLabel(pane.tabId, worktreeId) ?? agent
                  }}
                />
              ) : null}
            </NativeChatForkSlotContext.Provider>
          </NativeChatForkedFromContext.Provider>
        </NativeChatSideChatForkPointContext.Provider>
      </NativeChatForkContext.Provider>
    </NativeChatRewindContext.Provider>
  )
}
