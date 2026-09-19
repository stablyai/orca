import { useCallback } from 'react'
import type { AgentLaunchRoutingInput } from '@/lib/agent-launch-routing'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultResumeInChatEligibility } from './ai-vault-session-resume-in-chat'
import { resolveAiVaultSessionResumeInChatForWorkspace } from './ai-vault-session-resume-in-chat-workspace'
import type {
  AiVaultSessionResumeState,
  AiVaultSessionResumeTargetState
} from './ai-vault-session-resume'

export function useAiVaultSessionResumeInChat({
  getSessionResumeState,
  activeWorkspaceId,
  targetState,
  settings
}: {
  getSessionResumeState: (session: AiVaultSession) => AiVaultSessionResumeState
  activeWorkspaceId: string | null
  targetState: AiVaultSessionResumeTargetState
  settings: AgentLaunchRoutingInput['settings']
}): (session: AiVaultSession) => AiVaultResumeInChatEligibility {
  // Why: chat resume asks whether the provider can still find this conversation
  // from the launch cwd, not whether the workspace can host a PTY.
  return useCallback(
    (session: AiVaultSession): AiVaultResumeInChatEligibility =>
      resolveAiVaultSessionResumeInChatForWorkspace({
        session,
        resumeState: getSessionResumeState(session),
        activeWorkspaceId,
        targetState,
        settings
      }),
    [activeWorkspaceId, getSessionResumeState, settings, targetState]
  )
}
