import { getRuntimeGitUpstreamStatus } from '@/runtime/source-control/git/runtime-git-sync-client'

type UpstreamStatus = Awaited<ReturnType<typeof getRuntimeGitUpstreamStatus>>

/** A push target or an unproven patch-equivalent divergence needs its own upstream read. */
export async function readManualRefreshRemoteStatus(
  statusContext: Parameters<typeof getRuntimeGitUpstreamStatus>[0],
  upstreamStatus: UpstreamStatus | undefined,
  pushTarget: Parameters<typeof getRuntimeGitUpstreamStatus>[1] | null
): Promise<UpstreamStatus | undefined> {
  if (pushTarget) {
    return getRuntimeGitUpstreamStatus(statusContext, pushTarget)
  }
  if (
    !upstreamStatus ||
    (upstreamStatus.ahead > 0 &&
      upstreamStatus.behind > 0 &&
      upstreamStatus.behindCommitsArePatchEquivalent === undefined)
  ) {
    return getRuntimeGitUpstreamStatus(statusContext)
  }
  return upstreamStatus
}
