// Keep recents independent of IPC/Store so ordering can be tested directly.
import type { GitLabProjectSettings } from './gitlab-types'

export const GITLAB_RECENTS_MAX = 10

/** Return fresh, host/path-deduped recents capped at max, most recent first; caller persists via Store.updateSettings. */
export function computeNextGitLabRecents(
  existing: GitLabProjectSettings['recent'],
  host: string,
  path: string,
  now: Date = new Date(),
  max: number = GITLAB_RECENTS_MAX
): GitLabProjectSettings['recent'] {
  const filtered = existing.filter((entry) => !(entry.host === host && entry.path === path))
  return [{ host, path, lastOpenedAt: now.toISOString() }, ...filtered].slice(0, max)
}
