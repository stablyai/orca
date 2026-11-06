import { readGitCommandFailureText } from './git-command-failure-text'

// Why: only "another git process holds the lock" is transient; a CAS mismatch (`cannot lock ref ...: is at X but expected Y`) is not.
const GIT_LOCK_CONTENTION_PATTERNS = [
  /Unable to create '[^'\n]*\.lock': File exists/i,
  /could not lock config file [^\n]*: File exists/i
]

export const GIT_LOCK_CONTENTION_RETRY_DELAYS_MS: readonly number[] = [50, 150, 400]

export function isGitLockContentionFailure(error: unknown): boolean {
  const text = readGitCommandFailureText(error)
  return GIT_LOCK_CONTENTION_PATTERNS.some((pattern) => pattern.test(text))
}

/** Re-runs `attempt` after each lock-contention failure; any other failure, or the last one, is thrown. */
export async function retryOnGitLockContention<T>(
  attempt: () => Promise<T>,
  delaysMs: readonly number[] = GIT_LOCK_CONTENTION_RETRY_DELAYS_MS
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await attempt()
    } catch (error) {
      const delayMs = delaysMs[retry]
      if (delayMs === undefined || !isGitLockContentionFailure(error)) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}
