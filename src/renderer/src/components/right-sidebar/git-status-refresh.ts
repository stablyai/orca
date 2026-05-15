import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import type { GitStatusResult, GitUpstreamStatus, GlobalSettings } from '../../../../shared/types'

export type GitStatusRefreshDeps = {
  setGitStatus: (worktreeId: string, status: GitStatusResult) => void
  updateWorktreeGitIdentity: (
    worktreeId: string,
    identity: { head?: string; branch?: string }
  ) => void
  setUpstreamStatus: (worktreeId: string, status: GitUpstreamStatus) => void
  fetchUpstreamStatus: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string
  ) => Promise<void>
}

export async function refreshGitStatusForWorktree({
  settings,
  worktreeId,
  worktreePath,
  connectionId,
  deps
}: {
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId' | 'showGitIgnoredFiles'> | null
  worktreeId: string
  worktreePath: string
  connectionId?: string
  deps: GitStatusRefreshDeps
}): Promise<void> {
  // Why: setting is optional in the type for backward-compat with pre-feature
  // profiles, but the persistence merge fills the default before this runs.
  // Fall back to true so first-launch behavior matches getDefaultSettings.
  const includeIgnored = settings?.showGitIgnoredFiles ?? true
  const status = (await getRuntimeGitStatus(
    {
      settings,
      worktreeId,
      worktreePath,
      connectionId
    },
    { includeIgnored }
  )) as GitStatusResult

  deps.setGitStatus(worktreeId, status)
  // Why: branch switches can happen inside a terminal. `git status --branch`
  // gives us the new identity without a separate worktree-list poll.
  deps.updateWorktreeGitIdentity(worktreeId, {
    head: status.head,
    branch: status.branch
  })
  if (status.upstreamStatus) {
    deps.setUpstreamStatus(worktreeId, status.upstreamStatus)
    return
  }
  await deps.fetchUpstreamStatus(worktreeId, worktreePath, connectionId)
}
