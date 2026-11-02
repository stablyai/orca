import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { aiVaultSessionCliForkWorktreeId } from './ai-vault-session-cli-fork'
import {
  aiVaultSessionRowResumeGating,
  type AiVaultSessionResumeState
} from './ai-vault-session-resume'
import type { AiVaultResumeInChatEligibility } from './ai-vault-session-resume-in-chat'

export type AiVaultSessionSurfaceSwitchTargets = {
  /** Where the resumed chat opens, or null when it is not offered. */
  resumeInNewChatWorkspaceId: string | null
  /** Where the terminal fork opens, or null when it is not offered. */
  resumeInNewCliWorktreeId: string | null
}

/** Share native/CLI surface-switch eligibility between session rows and tab menus. */
export function resolveAiVaultSessionSurfaceSwitchTargets(
  session: Pick<
    AiVaultSession,
    'agent' | 'sessionId' | 'filePath' | 'messageCount' | 'previewMessages' | 'structuredSession'
  >,
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
