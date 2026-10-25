// Why: per-repo fetch budget for gh CLI calls. Kept in shared/ so the renderer's
// prefetch sites (SidebarNav, ui.ts openTaskPage) and the TaskPage all use the
// same value for cache-key alignment.
export const PER_REPO_FETCH_LIMIT = 36

// Why: how many items to show after cross-repo merge. Decoupled from the per-repo
// fetch limit so changing the display cap doesn't invalidate cache keys.
export const CROSS_REPO_DISPLAY_LIMIT = 100

export const GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE =
  'GitHub work items require a GitHub remote for SSH repositories'

export function isGitHubWorkItemsSshRemoteRequiredError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : typeof error === 'string'
          ? error
          : ''

  return message.includes(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE)
}

// Why: generic over item shape because main-process callers emit items without
// repoId (stamped by the renderer after IPC), while renderer callers carry the
// full GitHubWorkItem. Sorting by number descending matches GitHub's default
// Issues view (newest issue number first).
export function sortWorkItemsByNumber<T extends { number: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => right.number - left.number)
}

// Why: GitHub 422s search pages that start past its 1000-result window.
export const GITHUB_SEARCH_RESULT_WINDOW = 1000

export function taskPageToGitHubApiPage(taskPage: number): number {
  return Math.max(0, Math.floor(taskPage)) + 1
}

// Why: provider pages cannot spill truncated rows into the next page. Divide
// the display budget up front so every fetched row remains reachable.
export function getTaskPagePerRepoLimit(
  repoCount: number,
  maxPerRepo: number,
  displayLimit: number
): number {
  const normalizedRepoCount = Math.max(1, Math.floor(repoCount))
  return Math.max(1, Math.min(maxPerRepo, Math.floor(displayLimit / normalizedRepoCount)))
}

// Why: repos advance independently by page, so take the max across repos — a sum/page-width
// undercounts when one repo owns most results.
export function getWorkItemCountedTotalPages(
  counts: readonly number[],
  perRepoLimit: number
): number {
  const normalizedLimit = Math.max(1, Math.floor(perRepoLimit))
  const maxReachablePages = Math.max(1, Math.ceil(GITHUB_SEARCH_RESULT_WINDOW / normalizedLimit))
  return counts.reduce(
    (maxPages, count) =>
      Math.max(maxPages, Math.min(Math.ceil(count / normalizedLimit), maxReachablePages)),
    0
  )
}
