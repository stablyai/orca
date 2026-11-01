import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getAiVaultResumeWorkspacePath } from '@/lib/ai-vault-resume-shell'
import { resolveWorktreeExecutionHostPlatform } from '@/lib/execution-host-facts'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { parseWslUncPath } from '../../../shared/wsl-paths'

export type AiVaultResumePlatformState = Parameters<typeof resolveWorktreeExecutionHostPlatform>[0]

/** The OS of the host that runs the resumed agent; null when an SSH or paired host has not reported it. */
export function getAiVaultResumePlatform(
  state: AiVaultResumePlatformState,
  worktreeId?: string | null
): NodeJS.Platform | null {
  const targetWorktreeId = worktreeId ?? state.activeWorktreeId
  const executionHost = parseExecutionHostId(getExecutionHostIdForWorktree(state, targetWorktreeId))
  if (executionHost?.kind === 'ssh' || executionHost?.kind === 'runtime') {
    if (!targetWorktreeId) {
      return null
    }
    const fact = resolveWorktreeExecutionHostPlatform(
      state,
      targetWorktreeId,
      getAiVaultResumeWorkspacePath(state, targetWorktreeId)
    )
    return fact.kind === 'known' ? fact.platform : null
  }

  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId, CLIENT_PLATFORM)
  if (projectRuntime?.status === 'repair-required') {
    return projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }

  const workspacePath = getAiVaultResumeWorkspacePath(state, targetWorktreeId)
  return workspacePath && parseWslUncPath(workspacePath) ? 'linux' : CLIENT_PLATFORM
}
