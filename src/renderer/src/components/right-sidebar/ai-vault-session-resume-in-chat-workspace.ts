import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import {
  structuredAgentSessionLaunchFeasible,
  type AgentSessionStructuredFeasibilityRequest
} from '@/lib/agent-session-launch-plan'
import { useAppStore } from '@/store'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { resolveAiVaultTargetWorkspacePath } from './ai-vault-session-launch-target'
import {
  resolveAiVaultSessionResumeInChatEligibility,
  type AiVaultResumeInChatEligibility
} from './ai-vault-session-resume-in-chat'
import { resolveAiVaultSessionResumeInChatOwner } from './ai-vault-session-resume-in-chat-owner'
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
  // One synchronous store read for the whole row, so the owner, its capability answer and the
  // route below all describe the same moment.
  const store = useAppStore.getState()
  const ownerVerdict = resolveAiVaultSessionResumeInChatOwner({
    store,
    sessionExecutionHostId: args.session.executionHostId,
    sessionFilePath: args.session.filePath,
    targetWorkspaceId
  })
  return resolveAiVaultSessionResumeInChatEligibility({
    session: args.session,
    targetWorkspaceId,
    targetWorkspacePath,
    targetExecutionHostId: ownerVerdict.executionHostId,
    ownerSupportsResumeHistory: ownerVerdict.adoptable,
    structuredRouteAvailable:
      isAgentSessionHandleProvider(args.session.agent) &&
      targetWorkspaceId !== null &&
      structuredAgentSessionLaunchFeasible(store, {
        agent: args.session.agent,
        workspace: {
          kind: workspaceKindForWorktreeId(targetWorkspaceId),
          worktreeId: targetWorkspaceId
        },
        settings: args.settings
      })
  })
}
