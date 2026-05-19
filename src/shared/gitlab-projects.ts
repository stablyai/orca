// Why: pure helpers for GitLabProjectSettings — kept out of the IPC
// handler so the recents logic is testable without mocking the Store.
import type { GitLabProjectSettings } from './types'

/** Default max recents kept before older entries fall off. */
export const GITLAB_RECENTS_MAX = 10

/**
 * Compute the next `recent` list when a project at (host, path) is
 * opened. Most-recent-first ordering, dedupes by host+path, caps at
 * `max` entries. Returns a fresh array — caller is responsible for
 * persisting via `Store.updateSettings`.
 */
export function computeNextGitLabRecents(
  existing: GitLabProjectSettings['recent'],
  host: string,
  path: string,
  now: Date = new Date(),
  max: number = GITLAB_RECENTS_MAX
): GitLabProjectSettings['recent'] {
  // Why: filter before prepend so re-opening an already-recent project
  // moves it to the front rather than producing a duplicate.
  const filtered = existing.filter((entry) => !(entry.host === host && entry.path === path))
  return [{ host, path, lastOpenedAt: now.toISOString() }, ...filtered].slice(0, max)
}
