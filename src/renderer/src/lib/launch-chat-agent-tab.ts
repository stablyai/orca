import { useAppStore } from '@/store'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/types'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { hydrateChatSession, loadChatConversation } from '@/components/chat-pane/chat-session-store'
import type { JcodeConversationSummary } from '../../../shared/jcode-chat-types'

export type ChatAgentLaunchResult = {
  tabId: string
  startupPlan: AgentStartupPlan
  pasteDraftAfterLaunch: boolean
}

/**
 * Launch a chat-mode agent (jcode, M1) into a 'chat' content-type tab.
 *
 * Why: chat-mode agents are not hosted in an xterm PTY. They run headless via
 * `jcode run --ndjson` inside ChatPane, which spawns its own child process per
 * turn. So instead of building a shell startup command and a terminal tab, we
 * create a unified tab with contentType 'chat' and flip the visible surface to
 * editor (chat maps to the editor visible-tab type). This is the wiring that
 * makes TUI_AGENT_CONFIG[agent].renderMode === 'chat' actually reach
 * TabGroupPanel's chat render branch — without it the chat view is unreachable
 * and the agent falls back to a bare terminal.
 */
export function launchChatAgentTab(args: {
  agent: TuiAgent
  worktreeId: string
  groupId?: string
  quickCommandLabel?: string | null
}): ChatAgentLaunchResult {
  const { agent, worktreeId, groupId, quickCommandLabel } = args
  const store = useAppStore.getState()
  const chatTab = store.createUnifiedTab(worktreeId, 'chat', {
    ...(groupId ? { targetGroupId: groupId } : {}),
    label: 'jcode',
    ...(quickCommandLabel !== undefined ? { quickCommandLabel } : {}),
    activate: true
  })
  // Why: 'chat' maps to the 'editor' visible-tab type (see toVisibleTabType),
  // so the worktree must show the editor surface or the new chat tab stays
  // hidden behind whatever terminal/browser surface was active.
  store.setActiveTabType('editor')
  return {
    tabId: chatTab.id,
    // Why: chat mode has no shell startup command; surface a minimal plan so
    // callers keep the non-null result contract (QuickLaunch reads tabId).
    startupPlan: {
      agent,
      launchCommand: '',
      expectedProcess: TUI_AGENT_CONFIG[agent].expectedProcess,
      followupPrompt: null
    },
    pasteDraftAfterLaunch: false
  }
}

/**
 * Reopen a previously-closed (or restart-lost) jcode chat conversation.
 *
 * Why (BUG 1/2, reopen): jcode chat tabs are unified tabs whose conversation
 * lives in chat-session-store keyed by the tab id (== sessionKey). A closed chat
 * leaves a durable on-disk record (see jcode-conversation-store). To reopen it we
 * recreate a unified 'chat' tab with the SAME id as the stored sessionKey so the
 * store key lines up, then rehydrate that key from disk. Using the stored
 * worktreeId keeps the tab in its original group; callers that no longer have
 * that worktree must pass a fallback.
 *
 * Returns the (re)created tab id, or null when no worktree context is available.
 */
export async function reopenChatConversation(args: {
  conversation: Pick<JcodeConversationSummary, 'sessionKey' | 'worktreeId'>
  /** Used when the stored worktreeId is missing (worktree gone since restart). */
  fallbackWorktreeId?: string
  groupId?: string
}): Promise<string | null> {
  const { conversation, fallbackWorktreeId, groupId } = args
  const worktreeId = conversation.worktreeId ?? fallbackWorktreeId
  if (!worktreeId) {
    // Why: a chat tab must live in some worktree/group. With neither the stored
    // worktree nor a fallback we cannot place it; caller should supply a fallback.
    return null
  }

  const store = useAppStore.getState()

  // If a tab with this id is already open, just activate it (idempotent reopen).
  const existing = (store.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.id === conversation.sessionKey
  )
  if (existing) {
    store.activateTab(conversation.sessionKey)
    store.setActiveTabType('editor')
    return conversation.sessionKey
  }

  // Rehydrate the in-memory store BEFORE the tab mounts so ChatPane paints the
  // restored transcript immediately (ChatPane also rehydrates on mount as a
  // belt-and-suspenders path, but that one is a no-op once we've seeded here).
  const record = await loadChatConversation(conversation.sessionKey)
  if (record) {
    hydrateChatSession(record)
  }

  const chatTab = store.createUnifiedTab(worktreeId, 'chat', {
    // Critical: reuse the stored sessionKey as the tab id so store keys match.
    id: conversation.sessionKey,
    ...(groupId ? { targetGroupId: groupId } : {}),
    label: 'jcode',
    activate: true
  })
  store.setActiveTabType('editor')
  return chatTab.id
}
