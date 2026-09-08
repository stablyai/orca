import { useCallback } from 'react'
import {
  structuredAgentLaunchSupported,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { readLocalRuntimeCapabilitiesOrUnknown } from '@/runtime/local-runtime-capabilities'
import { useAppStore } from '@/store'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import {
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import { resolveAiVaultTargetWorkspacePath } from './ai-vault-session-launch-target'
import { aiVaultSessionResumeInChatWorkspaceId } from './ai-vault-session-resume-in-chat'
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
  /** Null while the local runtime has not answered a capability probe yet. */
  hostCapabilities: readonly RuntimeCapability[] | null
}): string | null {
  const targetWorkspaceId = args.resumeState.usesSessionWorktree
    ? args.resumeState.worktreeId
    : (args.resumeState.worktreeId ?? args.activeWorkspaceId)
  if (!targetWorkspaceId || !isAgentSessionHandleProvider(args.session.agent)) {
    return null
  }
  const state = useAppStore.getState()
  const structuredRouteAvailable =
    structuredAgentLaunchSupported({
      agent: args.session.agent,
      settings: args.settings,
      executionHostId: getExecutionHostIdForWorktree(state, targetWorkspaceId),
      hostCapabilities: args.hostCapabilities,
      workspaceKind: targetWorkspaceId.startsWith('folder:') ? 'folder' : 'git-worktree',
      projectRuntime: getLocalProjectExecutionRuntimeContext(state, targetWorkspaceId)
    }) &&
    (args.hostCapabilities ?? []).includes(
      STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
    )
  return aiVaultSessionResumeInChatWorkspaceId({
    session: args.session,
    targetWorkspaceId,
    targetWorkspacePath: resolveAiVaultTargetWorkspacePath(args.targetState, targetWorkspaceId),
    structuredRouteAvailable
  })
}

/** Shares the workspace-aware eligibility callback used by history rows. */
export function useAiVaultSessionResumeInChat({
  getResumeState,
  activeWorkspaceId,
  targetState,
  settings
}: {
  getResumeState: (session: AiVaultSession) => AiVaultSessionResumeState
  activeWorkspaceId: string | null
  targetState: AiVaultSessionResumeTargetState
  settings: AgentLaunchRoutingInput['settings']
}): (session: AiVaultSession) => string | null {
  // Why: read once per panel render rather than once per visible row per render, and let a
  // re-probed capability list change the callback identity so rows re-evaluate.
  const hostCapabilities = readLocalRuntimeCapabilitiesOrUnknown()
  return useCallback(
    (session: AiVaultSession) =>
      resolveAiVaultSessionResumeInChatForWorkspace({
        session,
        resumeState: getResumeState(session),
        activeWorkspaceId,
        targetState,
        settings,
        hostCapabilities
      }),
    [getResumeState, activeWorkspaceId, targetState, settings, hostCapabilities]
  )
}
