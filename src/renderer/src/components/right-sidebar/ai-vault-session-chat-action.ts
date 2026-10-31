import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault-search-types'
import type { AiVaultOriginalPaneTarget } from './ai-vault-original-pane'
import { canResumeAiVaultSearchHit } from './ai-vault-search-session'
import {
  aiVaultSessionRowResumeGating,
  type AiVaultSessionResumeState
} from './ai-vault-session-resume'
import type { AiVaultResumeInChatEligibility } from './ai-vault-session-resume-in-chat'
import {
  resolveAiVaultSessionSurfaceSwitchTargets,
  type AiVaultSessionSurfaceSwitchTargets
} from './ai-vault-session-surface-switch'

export type AiVaultSessionRowChatActions = AiVaultSessionSurfaceSwitchTargets & {
  canJumpToOriginalPane: boolean
  /** The row's own resume (▶) is greyed out; it is hidden instead while the chat is open. */
  resumeDisabled: boolean
  /** Where ▶ resumes the session, or null when ▶ is greyed out or hidden. */
  resumeWorktreeId: string | null
}

export function resolveAiVaultSessionRowChatActions(args: {
  session: AiVaultSession
  originalPaneTarget: AiVaultOriginalPaneTarget | null
  structuredSessionOpen: boolean
  resumeState: AiVaultSessionResumeState | null
  resumeInChat: AiVaultResumeInChatEligibility | null
  searchHit: AiVaultSearchHit | undefined
}): AiVaultSessionRowChatActions {
  const searchResumeAllowed = args.searchHit ? canResumeAiVaultSearchHit(args.searchHit) : true
  const targets = resolveAiVaultSessionSurfaceSwitchTargets(
    args.session,
    args.resumeState,
    args.resumeInChat
  )
  const resumeDisabled =
    !searchResumeAllowed ||
    aiVaultSessionRowResumeGating(args.session, args.resumeState).resumeDisabled
  return {
    canJumpToOriginalPane: Boolean(args.originalPaneTarget) || args.structuredSessionOpen,
    resumeDisabled,
    resumeWorktreeId:
      args.structuredSessionOpen || resumeDisabled ? null : (args.resumeState?.worktreeId ?? null),
    resumeInNewChatWorkspaceId: searchResumeAllowed ? targets.resumeInNewChatWorkspaceId : null,
    resumeInNewCliWorktreeId: searchResumeAllowed ? targets.resumeInNewCliWorktreeId : null
  }
}
