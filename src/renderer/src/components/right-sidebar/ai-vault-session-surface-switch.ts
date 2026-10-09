import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { aiVaultSessionCliForkWorktreeId } from './ai-vault-session-cli-fork'
import {
  aiVaultSessionRowResumeGating,
  type AiVaultSessionResumeState
} from './ai-vault-session-resume'
import type { AiVaultResumeInChatEligibility } from './ai-vault-session-resume-in-chat'

export type AiVaultSessionSurfaceSwitchTargets = {
  /** Where "Resume in New Native Chat" opens, or null when it is not offered. */
  resumeInNewChatWorkspaceId: string | null
  /** Where "Resume in New CLI" opens its fork, or null when it is not offered. */
  resumeInNewCliWorktreeId: string | null
}

/** The one gate for moving a session between native chat and the CLI, shared by the session-history
 *  row and the tab menu so both offer the move in exactly the same cases. */
export function resolveAiVaultSessionSurfaceSwitchTargets(
  session: Pick<AiVaultSession, 'agent' | 'messageCount' | 'previewMessages' | 'structuredSession'>,
  resumeState: AiVaultSessionResumeState | null,
  resumeInChat: AiVaultResumeInChatEligibility | null
): AiVaultSessionSurfaceSwitchTargets {
  return {
    resumeInNewChatWorkspaceId: resumeInChat?.available ? resumeInChat.workspaceId : null,
    resumeInNewCliWorktreeId: aiVaultSessionCliForkWorktreeId(session, {
      worktreeId: resumeState?.worktreeId,
      disabled: aiVaultSessionRowResumeGating(session, resumeState).resumeDisabled
    })
  }
}
