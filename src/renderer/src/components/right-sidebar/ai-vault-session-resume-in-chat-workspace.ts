import {
  structuredAgentLaunchSupported,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
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
  settings: AgentLaunchRoutingInput['settings']
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
      Boolean(targetWorkspaceId) &&
      structuredAgentLaunchSupported({
        agent: args.session.agent,
        settings: args.settings,
        executionHostId: getExecutionHostIdForWorktree(
          useAppStore.getState(),
          targetWorkspaceId as string
        ),
        platform: CLIENT_PLATFORM,
        hostCapabilities: readLocalRuntimeCapabilities(),
        workspaceKind: (targetWorkspaceId as string).startsWith('folder:')
          ? 'folder'
          : 'git-worktree',
        projectRuntime: getLocalProjectExecutionRuntimeContext(
          useAppStore.getState(),
          targetWorkspaceId as string
        )
      }) &&
      readLocalRuntimeCapabilities().includes(
        STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
      )
  })
}
