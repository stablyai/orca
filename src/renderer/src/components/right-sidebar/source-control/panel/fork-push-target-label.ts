import type { GitPushTarget } from '../../../../../../shared/worktree/types'

// Name fork push destinations as owner:branch when possible, falling back to a sanitized remote name.
export function describeForkPushTarget(pushTarget: GitPushTarget): string {
  const ownerMatch = pushTarget.remoteUrl?.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/)
  const owner = ownerMatch?.[1]
  return owner
    ? `${owner}:${pushTarget.branchName}`
    : `${pushTarget.remoteName}/${pushTarget.branchName}`
}
