import type { GitStatusResult, GitUpstreamStatus } from '../../../../shared/types'

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
  worktreeId,
  worktreePath,
  connectionId,
  deps
}: {
  worktreeId: string
  worktreePath: string
  connectionId?: string
  deps: GitStatusRefreshDeps
}): Promise<void> {
  const status = (await window.api.git.status({
    worktreePath,
    connectionId
  })) as GitStatusResult

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
