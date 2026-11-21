import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultSearchHit } from '../../../../../../shared/ai-vault/search/ai-vault-search-types'
import type { AiVaultOriginalPaneTarget } from './ai-vault-original-pane'
import type { AiVaultSessionResumeState } from './ai-vault-session-resume'
import type { AiVaultResumeInChatEligibility } from './ai-vault-session-resume-in-chat'
import { resolveAiVaultSessionRowChatActions } from './ai-vault-session-chat-action'

/** A row's chat actions, and the direct open that conversation navigation uses in their place. */
export function aiVaultSessionRowChat(row: {
  getOriginalPaneTarget: (session: AiVaultSession) => AiVaultOriginalPaneTarget | null
  isStructuredSessionOpen: (session: AiVaultSession) => boolean
  getSessionResumeState: (session: AiVaultSession) => AiVaultSessionResumeState
  getSessionResumeInChat: (session: AiVaultSession) => AiVaultResumeInChatEligibility
  searchHits?: ReadonlyMap<string, AiVaultSearchHit>
  onResume: (session: AiVaultSession, worktreeId: string) => void
  onJumpToOriginalPane: (session: AiVaultSession) => void
  onResumeInNewChat: (session: AiVaultSession, worktreeId: string) => void
}) {
  const rowActions = (session: AiVaultSession) =>
    resolveAiVaultSessionRowChatActions({
      session,
      originalPaneTarget: row.getOriginalPaneTarget(session),
      structuredSessionOpen: row.isStructuredSessionOpen(session),
      resumeState: row.getSessionResumeState(session),
      resumeInChat: row.getSessionResumeInChat(session),
      searchHit: row.searchHits?.get(session.id)
    })
  /** Opens the session's own chat, its original pane or a new chat; false when none applies. */
  const openConversation = (session: AiVaultSession): boolean => {
    if (session.structuredSession) {
      row.onResume(session, session.structuredSession.workspaceId)
      return true
    }
    const actions = rowActions(session)
    if (actions.canJumpToOriginalPane) {
      row.onJumpToOriginalPane(session)
      return true
    }
    if (actions.resumeInNewChatWorkspaceId) {
      row.onResumeInNewChat(session, actions.resumeInNewChatWorkspaceId)
      return true
    }
    return false
  }
  return { rowActions, openConversation }
}
