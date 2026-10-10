import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getAiVaultResumeWorkspacePath } from '@/lib/ai-vault-resume-shell'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { parseWslUncPath } from '../../../shared/wsl-paths'

// Which platform's grammar an Agent Session History resume is written in: the target
// workspace's host, or Linux when the agent runs over SSH, a paired runtime, or WSL.

export function getAiVaultResumeCodexHome(
  codexHome: string | null,
  platform: NodeJS.Platform
): string | null {
  // Why: WSL UNC Codex homes must be POSIX when invoking Linux commands.
  // Keep original paths unchanged for non-Linux targets.
  if (!codexHome || platform !== 'linux') {
    return codexHome
  }
  return parseWslUncPath(codexHome)?.linuxPath ?? codexHome
}

export function getAiVaultResumePlatform(
  state: Pick<
    AppState,
    | 'activeRepoId'
    | 'activeWorktreeId'
    | 'folderWorkspaces'
    | 'projectGroups'
    | 'projects'
    | 'repos'
    | 'settings'
    | 'worktreesByRepo'
  >,
  worktreeId?: string | null
): NodeJS.Platform {
  const targetWorktreeId = worktreeId ?? state.activeWorktreeId
  const executionHost = parseExecutionHostId(getExecutionHostIdForWorktree(state, targetWorktreeId))
  if (executionHost?.kind === 'ssh' || executionHost?.kind === 'runtime') {
    return 'linux'
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
