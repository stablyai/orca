// Why: durable per-review refs avoid shared FETCH_HEAD races and keep the head
// commit reachable between resolve and worktree create. Client (main) and relay
// must agree on these paths, so both import from here rather than hardcoding.

// Why: an unreachable or stalled remote must fail review-head resolve/create,
// not hang it; client and relay fetches share one bound.
export const REVIEW_HEAD_FETCH_TIMEOUT_MS = 60_000

// Why: refs are keyed by hosting identity (remote name + URL hash), not just
// PR/MR number — otherwise soft-keep after a failed fetch could serve PR #42
// of a different project (repointed origin, switched preferred remote).
export function reviewHeadRemoteRefComponent(remote: string, remoteUrl: string): string {
  return `${sanitizeRemoteRefComponent(remote)}-${fnv1a64Hex(remoteUrl.trim())}`
}

export function githubPullRequestHeadLocalRef(remoteComponent: string, prNumber: number): string {
  return `refs/orca/pull/${remoteComponent}/${prNumber}`
}

export function gitlabMergeRequestHeadLocalRef(remoteComponent: string, mrIid: number): string {
  return `refs/orca/merge-requests/${remoteComponent}/${mrIid}`
}

// Why: remote names may hold chars invalid in a ref component; the URL hash
// carries uniqueness, so lossy sanitization here is safe.
function sanitizeRemoteRefComponent(remote: string): string {
  const cleaned = remote.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-.]+|\.+$/g, '')
  return cleaned || 'remote'
}

function fnv1a64Hex(value: string): string {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

// Why: PR/MR numbers are interpolated into refspecs; relay and local fetch
// paths must reject non-integers with one shared guard.
export function isValidReviewHeadNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

// Why: a remote beginning with "-" would be parsed as a git option.
export function isSafeReviewHeadFetchRemote(remote: string): boolean {
  return !remote.startsWith('-')
}

/**
 * Match durable local refs written for a GitHub PR number (any hosting remote
 * component). Shape: refs/orca/pull/<remoteComponent>/<prNumber>
 */
export function isGithubPullRequestHeadLocalRefForNumber(
  refName: string,
  prNumber: number
): boolean {
  if (!isValidReviewHeadNumber(prNumber)) {
    return false
  }
  const prefix = 'refs/orca/pull/'
  if (!refName.startsWith(prefix)) {
    return false
  }
  const rest = refName.slice(prefix.length)
  // Why: durable shape is exactly <remoteComponent>/<number> — reject nested paths.
  const parts = rest.split('/')
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    return false
  }
  return parts[1] === String(prNumber)
}

/**
 * Match durable local refs written for a GitLab MR iid.
 * Shape: refs/orca/merge-requests/<remoteComponent>/<mrIid>
 */
export function isGitlabMergeRequestHeadLocalRefForNumber(refName: string, mrIid: number): boolean {
  if (!isValidReviewHeadNumber(mrIid)) {
    return false
  }
  const prefix = 'refs/orca/merge-requests/'
  if (!refName.startsWith(prefix)) {
    return false
  }
  const rest = refName.slice(prefix.length)
  // Why: durable shape is exactly <remoteComponent>/<number> — reject nested paths.
  const parts = rest.split('/')
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    return false
  }
  return parts[1] === String(mrIid)
}

/** Select refs to delete after the last worktree for a PR/MR is removed (#10431). */
export function selectReviewHeadLocalRefsToPrune(
  refNames: readonly string[],
  targets: { githubPrNumber?: number | null; gitlabMrIid?: number | null }
): string[] {
  const selected: string[] = []
  for (const refName of refNames) {
    if (
      targets.githubPrNumber != null &&
      isGithubPullRequestHeadLocalRefForNumber(refName, targets.githubPrNumber)
    ) {
      selected.push(refName)
      continue
    }
    if (
      targets.gitlabMrIid != null &&
      isGitlabMergeRequestHeadLocalRefForNumber(refName, targets.gitlabMrIid)
    ) {
      selected.push(refName)
    }
  }
  return selected
}
