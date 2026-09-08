import { readGitReviewPushAuthority } from './git-review-push-authority'
import { readGitRemoteTrackingRef } from './git-remote-tracking-ref'
import type { GitUpstreamStatusIdentity } from './git-upstream-identity'
import type { GitUpstreamStatus } from './git-status-types'
import type { GitPushTarget } from './worktree/types'
import { parseGitRevListAheadBehindCounts } from './git-rev-list-output'

export type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

export function getPublishTargetDisplayName(target: GitPushTarget): string {
  return `${target.remoteName}/${target.branchName}`
}

export function getPublishTargetRemoteRef(target: GitPushTarget): string {
  return `refs/remotes/${target.remoteName}/${target.branchName}`
}

export async function getPublishTargetStatus(
  runGit: GitCommandRunner,
  target: GitPushTarget,
  getBehindCommitsArePatchEquivalent?: (upstreamName: string) => Promise<boolean>
): Promise<GitUpstreamStatus> {
  const reviewPushAuthority = await readGitReviewPushAuthority(runGit, target)
  const upstreamName = getPublishTargetDisplayName(target)
  const remoteRef = await readGitRemoteTrackingRef(runGit, target.remoteName, target.branchName)
  const upstreamIdentity: GitUpstreamStatusIdentity = {
    selector: { kind: 'named-remote', value: target.remoteName },
    mergeRef: `refs/heads/${target.branchName}`,
    trackingRef: remoteRef
  }

  if (!remoteRef) {
    return {
      ...(target.reviewHead ? { reviewPushAuthority } : {}),
      hasUpstream: false,
      upstreamName,
      upstreamIdentity: { ...upstreamIdentity, trackingRef: null },
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    }
  }

  const { stdout } = await runGit(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`])
  const counts = parseGitRevListAheadBehindCounts(stdout)
  if (counts.status === 'unexpected-field-count') {
    throw new Error(`Unexpected git rev-list output: ${JSON.stringify(stdout)}`)
  }
  if (counts.status === 'unparseable-counts') {
    throw new Error(`Unparseable git rev-list counts: ${JSON.stringify(stdout)}`)
  }

  const behindCommitsArePatchEquivalent =
    counts.ahead > 0 && counts.behind > 0 && getBehindCommitsArePatchEquivalent
      ? await getBehindCommitsArePatchEquivalent(remoteRef)
      : undefined

  return {
    ...(target.reviewHead ? { reviewPushAuthority } : {}),
    hasUpstream: true,
    upstreamName,
    upstreamIdentity,
    ahead: counts.ahead,
    behind: counts.behind,
    ...(behindCommitsArePatchEquivalent !== undefined ? { behindCommitsArePatchEquivalent } : {})
  }
}
