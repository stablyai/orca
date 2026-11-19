// Durable review refs avoid FETCH_HEAD races and keep commits reachable through worktree creation; main/relay share these paths.

// Bound review-head fetches on both client and relay so unreachable remotes cannot hang creation.
export const REVIEW_HEAD_FETCH_TIMEOUT_MS = 60_000

// Include remote URL identity so failed-fetch fallback cannot serve another project’s same-numbered review.
export function reviewHeadRemoteRefComponent(remote: string, remoteUrl: string): string {
  return `${sanitizeRemoteRefComponent(remote)}-${fnv1a64Hex(remoteUrl.trim())}`
}

export function githubPullRequestHeadLocalRef(remoteComponent: string, prNumber: number): string {
  return `refs/orca/pull/${remoteComponent}/${prNumber}`
}

export function gitlabMergeRequestHeadLocalRef(remoteComponent: string, mrIid: number): string {
  return `refs/orca/merge-requests/${remoteComponent}/${mrIid}`
}

// Lossy remote-name sanitization is safe because the URL hash supplies uniqueness.
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

// One local/relay guard prevents non-integer review numbers reaching refspecs.
export function isValidReviewHeadNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

// Why: a remote beginning with "-" would be parsed as a git option.
export function isSafeReviewHeadFetchRemote(remote: string): boolean {
  return !remote.startsWith('-')
}
