import { getRuntimeGitStatus } from '@/runtime/source-control/git/runtime-git-status-client'
import { getRuntimeGitUpstreamStatus } from '@/runtime/source-control/git/runtime-git-sync-client'
import { getBranchLineTotalMergeBase } from './branch-line-total-request-gate'
import { clearAutomaticPushTargetUpstreamStatusCache } from './push-target-upstream-refresh-cache'
import type {
  GitStatusResult,
  GitUpstreamStatus
} from '../../../../../../shared/git/status/git-status-types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { GitPushTarget } from '../../../../../../shared/worktree/types'
import { beginStrictUpstreamRefresh } from './git-status-refresh-ordering'
import { tagUpstreamWithStatusHead, type RefreshGitStatusStrictDeps } from './git-status-refresh'

export async function refreshGitStatusForWorktreeStrict({
  target,
  ownerHostId,
  worktreeId,
  worktreePath,
  connectionId,
  pushTarget,
  deps
}: {
  /** The worktree owner's transport. */
  target: RuntimeClientTarget
  /** The copy `target` answers for, read when the request starts. */
  ownerHostId: ExecutionHostId | null
  worktreeId: string
  worktreePath: string
  connectionId?: string
  pushTarget?: GitPushTarget
  deps: RefreshGitStatusStrictDeps
}): Promise<{ status: GitStatusResult; upstreamStatus: GitUpstreamStatus }> {
  beginStrictUpstreamRefresh(worktreeId)
  clearAutomaticPushTargetUpstreamStatusCache()
  const strictBranchLineTotalMergeBase = getBranchLineTotalMergeBase(worktreeId)
  const status = await getRuntimeGitStatus(
    {
      target,
      worktreeId,
      worktreePath,
      connectionId
    },
    {
      admissionTier: 'interactive',
      // User-triggered reconciliation bypasses automatic polling's no-upstream backoff.
      bypassEffectiveUpstreamNegativeCache: true,
      // Keep the total gate after commit/push so missing totals cannot blank the updated chip.
      ...(strictBranchLineTotalMergeBase
        ? { branchLineTotalMergeBase: strictBranchLineTotalMergeBase }
        : {})
    }
  )

  deps.setGitStatus(worktreeId, status)
  // Read shell-driven branch changes from git status --branch without another worktree-list poll.
  deps.updateWorktreeGitIdentity(
    worktreeId,
    {
      head: status.head,
      // Detached HEAD needs explicit null to clear any stale branch name.
      branch: status.branch ?? (status.head ? null : undefined)
    },
    ownerHostId
  )
  const fetchTaggedUpstream = async (explicitPushTarget?: GitPushTarget) => {
    const upstreamStatus = await getRuntimeGitUpstreamStatus(
      { target, worktreeId, worktreePath, connectionId },
      explicitPushTarget
    )
    const tagged = tagUpstreamWithStatusHead(status, upstreamStatus)
    deps.setUpstreamStatus(worktreeId, tagged)
    return tagged
  }
  if (pushTarget) {
    // Use Orca's explicit publish target for PR-created worktrees rather than Git's configured upstream.
    return { status, upstreamStatus: await fetchTaggedUpstream(pushTarget) }
  }
  if (status.upstreamStatus) {
    if (
      status.upstreamStatus.ahead > 0 &&
      status.upstreamStatus.behind > 0 &&
      status.upstreamStatus.behindCommitsArePatchEquivalent === undefined
    ) {
      // Porcelain counts cannot identify stale post-rebase commits; compare first to avoid Sync/Force Push flicker.
      return { status, upstreamStatus: await fetchTaggedUpstream() }
    }
    const tagged = tagUpstreamWithStatusHead(status, status.upstreamStatus)
    deps.setUpstreamStatus(worktreeId, tagged)
    return { status, upstreamStatus: tagged }
  }
  return { status, upstreamStatus: await fetchTaggedUpstream() }
}
