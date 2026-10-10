import { toast } from 'sonner'
import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  aiVaultSessionHistoryChatTabId,
  canOpenAiVaultSessionHistoryChat
} from './ai-vault-session-history-chat'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

/**
 * Handles a history row that opens as a read-only chat tab, returning whether it did.
 *
 * ZCode has no structured-session host adapter, so its history cannot adopt into a live
 * structured chat; instead the row's conversation renders through the same live-session hook
 * the chat overlay uses, reading the agent's own store (`nativeChat:subscribe`). The tab
 * reuses the `agent-session` content type with the session id as its entity, so the tab bar,
 * persistence and close commands all work unchanged; `AiVaultSessionHistoryChatLayer` is the
 * body this tab paints.
 */
export function openAiVaultSessionHistoryChatForRow(
  session: AiVaultSession,
  worktreeId?: string | null
): boolean {
  if (!canOpenAiVaultSessionHistoryChat(session)) {
    return false
  }
  const tab = openAiVaultSessionHistoryChatTab(session, worktreeId)
  if (!tab) {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.openWorkspaceBeforeResuming',
        'Open a workspace before resuming a session.'
      )
    )
  }
  return true
}
export function openAiVaultSessionHistoryChatTab(
  session: AiVaultSession,
  /** The row's resolved target; defaults to the active worktree when the caller has none. */
  requestedWorktreeId?: string | null
): Tab | null {
  const state = useAppStore.getState()
  const worktreeId = requestedWorktreeId ?? state.activeWorktreeId
  // A named target the app has not mounted has no tab strip to paint into; falling
  // back to the active worktree would open the conversation in the wrong workspace.
  if (!worktreeId || !state.unifiedTabsByWorktree[worktreeId]) {
    return null
  }
  const tabId = aiVaultSessionHistoryChatTabId(session.sessionId)
  const existing = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === tabId && candidate.contentType === 'agent-session'
  )
  if (existing) {
    state.focusGroup(worktreeId, existing.groupId)
    state.activateTab(existing.id, { worktreeId })
    state.setActiveTabType('agent-session', worktreeId)
    return existing
  }
  const tab = state.createUnifiedTab(worktreeId, 'agent-session', {
    id: tabId,
    entityId: session.sessionId,
    agentSessionAgent: session.agent,
    label: session.title,
    activate: true
  })
  state.setActiveTabType('agent-session', worktreeId)
  return tab
}
