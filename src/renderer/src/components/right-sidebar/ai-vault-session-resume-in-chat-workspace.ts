import { resolveHostCapabilities, workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import {
  structuredAgentSessionLaunchFeasible,
  type AgentSessionStructuredFeasibilityRequest
} from '@/lib/agent-session-launch-plan'
import { resolveStructuredAgentSessionOwner } from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
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
  const state = useAppStore.getState()
  // The conversation lives on the host that recorded it, so only a chat on that same host can
  // resume it, the rule the terminal resume follows; that host also answers for the capability.
  const targetOwner = targetWorkspaceId
    ? resolveStructuredAgentSessionOwner(state, targetWorkspaceId)
    : null
  return resolveAiVaultSessionResumeInChatEligibility({
    session: args.session,
    targetWorkspaceId,
    targetWorkspacePath,
    structuredRouteAvailable:
      isAgentSessionHandleProvider(args.session.agent) &&
      targetWorkspaceId !== null &&
      targetOwner !== null &&
      targetOwner === normalizeExecutionHostId(args.session.executionHostId) &&
      structuredAgentSessionLaunchFeasible(state, {
        agent: args.session.agent,
        workspace: {
          kind: workspaceKindForWorktreeId(targetWorkspaceId),
          worktreeId: targetWorkspaceId
        },
        settings: args.settings
      }) &&
      resolveHostCapabilities(state, targetOwner)?.includes(
        STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
      ) === true
  })
}
