export const CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS = 25

// Why: mixed-version runtimes can still return these legacy conflicts instead
// of performing their own suffix retry, so every client needs one policy.
const RETRYABLE_WORKTREE_CREATE_CONFLICT_PATTERNS = [
  /already exists locally/i,
  /already exists on a remote/i,
  /^Branch ".+" already exists\./i,
  /already has pr #\d+/i
]

export function getClientWorktreeCreateCandidate(value: string, attempt: number): string {
  return attempt === 0 ? value : `${value}-${attempt + 1}`
}

export function isRetryableWorktreeCreateConflict(message: string): boolean {
  return RETRYABLE_WORKTREE_CREATE_CONFLICT_PATTERNS.some((pattern) => pattern.test(message))
}
