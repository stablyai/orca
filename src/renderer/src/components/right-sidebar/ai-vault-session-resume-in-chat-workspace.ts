import { resolveHostCapabilities, workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import {
  structuredAgentSessionLaunchFeasible,
  type AgentSessionStructuredFeasibilityRequest
} from '@/lib/agent-session-launch-plan'
import { resolveStructuredAgentSessionOwner } from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import {
  adoptsCliConversations,
  CLI_CONVERSATION_ADOPTING_AGENTS
} from '../../../../shared/structured-agent-cli-conversation-adoption'
import { STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { resolveAiVaultTargetWorkspacePath } from './ai-vault-session-launch-target'
import {
  resolveAiVaultSessionResumeInChatEligibility,
  type AiVaultResumeInChatEligibility
} from './ai-vault-session-resume-in-chat'
import {
  resolveAiVaultHistorySessionResumeState,
  type AiVaultSessionResumeState,
  type AiVaultSessionResumeTargetState
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
  // Like terminal resume, native resume requires the recording host, which also owns capability checks.
  const targetOwner = targetWorkspaceId
    ? resolveStructuredAgentSessionOwner(state, targetWorkspaceId)
    : null
  return resolveAiVaultSessionResumeInChatEligibility({
    session: args.session,
    targetWorkspaceId,
    targetWorkspacePath,
    structuredRouteAvailable:
      adoptsCliConversations(args.session.agent) &&
      targetWorkspaceId !== null &&
      targetOwner !== null &&
      targetOwner === normalizeExecutionHostId(args.session.executionHostId) &&
      CLI_CONVERSATION_ADOPTING_AGENTS[args.session.agent].some((agent) =>
        structuredAgentSessionLaunchFeasible(state, {
          agent,
          workspace: {
            kind: workspaceKindForWorktreeId(targetWorkspaceId),
            worktreeId: targetWorkspaceId
          },
          settings: args.settings
        })
      ) &&
      resolveHostCapabilities(state, targetOwner)?.includes(
        STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
      ) === true
  })
}

/** Share history-row resume eligibility across Session History and tab-menu actions. */
export function resolveAiVaultHistoryRowResume(
  args: Parameters<typeof resolveAiVaultHistorySessionResumeState>[0] & {
    targetState: AiVaultSessionResumeTargetState
    settings: AgentSessionStructuredFeasibilityRequest['settings']
  }
): { resumeState: AiVaultSessionResumeState; resumeInChat: AiVaultResumeInChatEligibility } {
  const { settings, ...resumeArgs } = args
  const resumeState = resolveAiVaultHistorySessionResumeState(resumeArgs)
  return {
    resumeState,
    resumeInChat: resolveAiVaultSessionResumeInChatForWorkspace({
      session: args.session,
      resumeState,
      activeWorkspaceId: args.activeWorktreeId,
      targetState: args.targetState,
      settings
    })
  }
}
