import type { GitPushTarget } from '../../../../shared/types'

// Why: a fork-PR worktree pushes to a contributor's fork, not origin. Render
// "owner:branch" from the fork remote URL when available so the maintainer can
// see at a glance where a push lands; fall back to the sanitized remote name.
export function describeForkPushTarget(pushTarget: GitPushTarget): string {
  const ownerMatch = pushTarget.remoteUrl?.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/)
  const owner = ownerMatch?.[1]
  return owner
    ? `${owner}:${pushTarget.branchName}`
    : `${pushTarget.remoteName}/${pushTarget.branchName}`
}
