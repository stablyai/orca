// The Idempotency-Key a GitHub-only Orca Cloud create sends (GH-CREATE-SHEET). One per creation.
// A Retry after a lost answer (the control plane never replied) resends the same key, so the server
// hands back the sandbox the first attempt may have made instead of starting a second one. A Retry
// after an answered failure is a new attempt with its own key: the server already released a key
// that created nothing, and one whose sandbox was deleted (a failed clone) must not replay it.

type KeyState = { key: string; attempts: number; lastUnanswered: boolean }

const keys = new Map<string, KeyState>()

/** The key for the next attempt of this creation. */
export function githubCreateIdempotencyKey(creationId: string): string {
  const state = keys.get(creationId)
  if (!state) {
    const key = `create:${creationId}`
    keys.set(creationId, { key, attempts: 0, lastUnanswered: false })
    return key
  }
  if (state.lastUnanswered) {
    return state.attempts === 0 ? state.key : `${state.key}:retry-${state.attempts}`
  }
  state.attempts += 1
  return `${state.key}:retry-${state.attempts}`
}

/** How the last attempt ended: `unanswered` when the control plane's answer never arrived. */
export function noteGitHubCreateOutcome(creationId: string, unanswered: boolean): void {
  const state = keys.get(creationId)
  if (state) {
    state.lastUnanswered = unanswered
  }
}

export function forgetGitHubCreateKey(creationId: string): void {
  keys.delete(creationId)
}

/** Tests only. */
export function resetGitHubCreateKeysForTest(): void {
  keys.clear()
}
