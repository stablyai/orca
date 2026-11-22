import { useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { closedWorkspaceChats } from '@/lib/agent-session/history/closed-workspace-chat'
import {
  workspaceChatCatalog,
  type WorkspaceChat
} from '@/lib/agent-session/history/workspace-chats'
import { openDesktopStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { WorkspaceChatList } from './workspace-chat-list'
import { waitForStructuredAgentSessionTabRetirement } from '@/runtime/native-chat/tab-retirement/structured-agent-session-host-tab-retirement'

const EMPTY_TABS: readonly Tab[] = []
let latestWorkspaceChatReopen = 0

async function openWorkspaceChat(chat: WorkspaceChat): Promise<void> {
  const target = structuredAgentSessionTargetForHost(chat.executionHostId)
  if (!target) {
    return
  }
  const reopen = ++latestWorkspaceChatReopen
  const activeWorkspace = useAppStore.getState().activeWorktreeId
  const retired = await waitForStructuredAgentSessionTabRetirement(
    target,
    chat.workspaceId,
    chat.sessionId
  )
  if (
    reopen !== latestWorkspaceChatReopen ||
    useAppStore.getState().activeWorktreeId !== activeWorkspace
  ) {
    return
  }
  if (!retired) {
    throw new Error('Host tab close failed before the saved chat could reopen')
  }
  if (
    activateAndRevealWorkspace(chat.workspaceId, {
      executionHostId: chat.executionHostId,
      providesInitialSurface: true
    }) === false
  ) {
    return
  }
  await openDesktopStructuredSession(
    {
      kind: 'history',
      structuredSession: { workspaceId: chat.workspaceId, sessionId: chat.sessionId },
      agent: chat.agent
    },
    target
  )
}

export function RetainedWorkspaceChats({
  worktreeId,
  executionHostId
}: {
  worktreeId: string
  executionHostId?: ExecutionHostId
}) {
  const catalog = workspaceChatCatalog()
  const chats = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot)
  const tabs = useAppStore((state) => state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_TABS)
  const owner = useAppStore(
    (state) => executionHostId ?? resolveStructuredAgentSessionOwner(state, worktreeId)
  )
  const tabOwners = useAppStore(
    useShallow((state) =>
      (state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_TABS).map(
        (tab) => structuredAgentSessionOwnerForTab(state, tab) ?? undefined
      )
    )
  )
  const normalizedTabs = tabs.map((tab, index) => ({
    ...tab,
    executionHostId: tabOwners[index]
  }))
  const closed = closedWorkspaceChats(chats, worktreeId, owner, normalizedTabs)
  return (
    <WorkspaceChatList
      chats={closed}
      onOpen={openWorkspaceChat}
      onArchive={(chat) => catalog.archive(chat)}
    />
  )
}
