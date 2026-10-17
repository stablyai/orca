import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceSet } from '../listing/worktree-slice-types'
import { isStructuredTab } from '../../../../../../shared/structured-agent-session-tab'
import {
  sleptChatWorkspaceKey,
  type SleptChatIdentity,
  type ExplicitlySleptChatsByWorkspace
} from '../../../../../../shared/workspace-chat-sleep'

export function withoutSelectedSleptChats(
  intents: ExplicitlySleptChatsByWorkspace,
  worktreeId: string,
  hostId: Parameters<typeof sleptChatWorkspaceKey>[1] | undefined
): ExplicitlySleptChatsByWorkspace {
  if (!hostId) {
    return intents
  }
  const key = sleptChatWorkspaceKey(worktreeId, hostId)
  if (!intents[key]) {
    return intents
  }
  const next = { ...intents }
  delete next[key]
  return next
}

export function createWorkspaceChatSleepActions(
  set: WorktreeSliceSet
): Pick<WorktreeSlice, 'markWorkspaceChatsSlept' | 'clearWorkspaceChatsSlept'> {
  return {
    markWorkspaceChatsSlept: (worktreeId, hostId, chats) =>
      set((state) => {
        const key = sleptChatWorkspaceKey(worktreeId, hostId)
        const current = state.explicitlySleptChatsByWorkspace[key] ?? []
        const accepted: SleptChatIdentity[] = []
        for (const chat of chats) {
          const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
            (candidate) => candidate.id === chat.tabId
          )
          if (
            !tab ||
            !isStructuredTab(tab) ||
            tab.entityId !== chat.sessionId ||
            tab.executionHostId !== hostId
          ) {
            continue
          }
          if (
            !current.some(
              (entry) => entry.tabId === chat.tabId && entry.sessionId === chat.sessionId
            )
          ) {
            accepted.push({ tabId: chat.tabId, sessionId: chat.sessionId })
          }
        }
        if (accepted.length === 0) {
          return state
        }
        return {
          explicitlySleptChatsByWorkspace: {
            ...state.explicitlySleptChatsByWorkspace,
            [key]: [...current, ...accepted]
          }
        }
      }),
    clearWorkspaceChatsSlept: (worktreeId, hostId, chats) =>
      set((state) => {
        const key = sleptChatWorkspaceKey(worktreeId, hostId)
        const current = state.explicitlySleptChatsByWorkspace[key]
        if (!current) {
          return state
        }
        if (!chats) {
          return {
            explicitlySleptChatsByWorkspace: withoutSelectedSleptChats(
              state.explicitlySleptChatsByWorkspace,
              worktreeId,
              hostId
            )
          }
        }
        const retained = current.filter(
          (entry) =>
            !chats.some((chat) => chat.tabId === entry.tabId && chat.sessionId === entry.sessionId)
        )
        if (retained.length === current.length) {
          return state
        }
        const next = { ...state.explicitlySleptChatsByWorkspace }
        if (retained.length > 0) {
          next[key] = retained
        } else {
          delete next[key]
        }
        return { explicitlySleptChatsByWorkspace: next }
      })
  }
}
