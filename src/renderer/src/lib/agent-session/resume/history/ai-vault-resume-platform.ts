import { CLIENT_PLATFORM } from '@/lib/workspace/creation/new-workspace'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import {
  getAiVaultResumeProjectRuntime,
  getAiVaultResumeWorkspacePath
} from '@/lib/agent-session/resume/history/ai-vault-resume-shell'
import { resolveWorktreeExecutionHostPlatform } from '@/runtime/hosts/platform/execution-host-facts'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import { parseWslUncPath } from '../../../../../../shared/wsl-paths'

export type AiVaultResumePlatformState = Parameters<typeof resolveWorktreeExecutionHostPlatform>[0]

/** The OS of the host that runs the resumed agent; null when an SSH or paired host has not reported it. */
export function getAiVaultResumePlatform(
  state: AiVaultResumePlatformState,
  worktreeId?: string | null,
  executionHostId?: ExecutionHostId | null
): NodeJS.Platform | null {
  const targetWorktreeId = worktreeId ?? state.activeWorktreeId
  const executionHost = parseExecutionHostId(
    executionHostId ?? getExecutionHostIdForWorktree(state, targetWorktreeId)
  )
  if (executionHost?.kind === 'ssh' || executionHost?.kind === 'runtime') {
    if (!targetWorktreeId) {
      return null
    }
    const targetState = executionHostId
      ? {
          ...state,
          activeWorktreeId: targetWorktreeId,
          activeWorkspaceExecutionHostId: executionHostId
        }
      : state
    const fact = resolveWorktreeExecutionHostPlatform(
      targetState,
      targetWorktreeId,
      getAiVaultResumeWorkspacePath(state, targetWorktreeId, executionHostId),
      executionHostId ?? undefined
    )
    return fact.kind === 'known' ? fact.platform : null
  }

  const projectRuntime = getAiVaultResumeProjectRuntime(state, worktreeId, executionHostId)
  if (projectRuntime?.status === 'repair-required') {
    return projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }

  const workspacePath = getAiVaultResumeWorkspacePath(state, targetWorktreeId, executionHostId)
  return workspacePath && parseWslUncPath(workspacePath) ? 'linux' : CLIENT_PLATFORM
}
