import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import type {
  GitPushTarget,
  GitStatusResult,
  GitUpstreamStatus,
  GlobalSettings
} from '../../../../shared/types'

export type GitStatusRefreshDeps = {
  setGitStatus: (worktreeId: string, status: GitStatusResult) => void
  updateWorktreeGitIdentity: (
    worktreeId: string,
    identity: { head?: string; branch?: string | null }
  ) => void
  setUpstreamStatus: (worktreeId: string, status: GitUpstreamStatus) => void
  fetchUpstreamStatus: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string,
    pushTarget?: GitPushTarget
  ) => Promise<void>
}

export async function refreshGitStatusForWorktree({
  settings,
  worktreeId,
  worktreePath,
  connectionId,
  pushTarget,
  deps
}: {
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  worktreeId: string
  worktreePath: string
  connectionId?: string
  pushTarget?: GitPushTarget
  deps: GitStatusRefreshDeps
}): Promise<void> {
  const status = (await getRuntimeGitStatus({
    settings,
    worktreeId,
    worktreePath,
    connectionId
  })) as GitStatusResult

  deps.setGitStatus(worktreeId, status)
  // Why: branch switches can happen inside a terminal. `git status --branch`
  // gives us the new identity without a separate worktree-list poll.
  deps.updateWorktreeGitIdentity(worktreeId, {
    head: status.head,
    // Why: detached HEAD reports a head oid and no branch. Pass null as an
    // explicit clear signal so stale branch names don't linger in the UI.
    branch: status.branch ?? (status.head ? null : undefined)
  })
  if (pushTarget) {
    // Why: porcelain status reports Git's configured upstream. Source Control
    // actions for PR-created worktrees must instead reconcile with Orca's
    // explicit publish target.
    await deps.fetchUpstreamStatus(worktreeId, worktreePath, connectionId, pushTarget)
    return
  }
  if (status.upstreamStatus) {
    if (
      status.upstreamStatus.ahead > 0 &&
      status.upstreamStatus.behind > 0 &&
      status.upstreamStatus.behindCommitsArePatchEquivalent === undefined
    ) {
      // Why: porcelain status has counts but cannot tell stale post-rebase
      // upstream commits from real remote work. Writing it first makes the
      // primary action flicker between Sync and Force Push on every poll.
      await deps.fetchUpstreamStatus(worktreeId, worktreePath, connectionId)
      return
    }
    deps.setUpstreamStatus(worktreeId, status.upstreamStatus)
    return
  }
  await deps.fetchUpstreamStatus(worktreeId, worktreePath, connectionId)
}
