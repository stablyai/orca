import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import {
  structuredAgentSessionLaunchFeasible,
  type AgentSessionStructuredFeasibilityRequest
} from '@/lib/agent-session-launch-plan'
import { readLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { useAppStore } from '@/store'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { resolveAiVaultTargetWorkspacePath } from './ai-vault-session-launch-target'
import {
  resolveAiVaultSessionResumeInChatEligibility,
  type AiVaultResumeInChatEligibility
} from './ai-vault-session-resume-in-chat'
import type {
  AiVaultSessionResumeState,
  AiVaultSessionResumeTargetState
} from './ai-vault-session-resume'

export function resolveAiVaultSessionResumeInChatForWorkspace(args: {
  session: AiVaultSession
  resumeState: AiVaultSessionResumeState
  activeWorkspaceId: string | null
  targetState: AiVaultSessionResumeTargetState
  settings: AgentSessionStructuredFeasibilityRequest['settings']
}): AiVaultResumeInChatEligibility {
  const targetWorkspaceId = args.resumeState.usesSessionWorktree
    ? args.resumeState.worktreeId
    : (args.resumeState.worktreeId ?? args.activeWorkspaceId)
  const targetWorkspacePath = targetWorkspaceId
    ? resolveAiVaultTargetWorkspacePath(args.targetState, targetWorkspaceId)
    : null
  return resolveAiVaultSessionResumeInChatEligibility({
    session: args.session,
    targetWorkspaceId,
    targetWorkspacePath,
    structuredRouteAvailable:
      isAgentSessionHandleProvider(args.session.agent) &&
      targetWorkspaceId !== null &&
      structuredAgentSessionLaunchFeasible(useAppStore.getState(), {
        agent: args.session.agent,
        workspace: {
          kind: workspaceKindForWorktreeId(targetWorkspaceId),
          worktreeId: targetWorkspaceId
        },
        settings: args.settings
      }) &&
      readLocalRuntimeCapabilities().includes(
        STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
      )
  })
}
