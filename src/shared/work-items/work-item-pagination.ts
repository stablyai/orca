// Share the per-repo fetch budget across main and renderer prefetch/read sites so cache keys agree.
export const PER_REPO_FETCH_LIMIT = 36

// Decouple display from fetch budget so changing the merged cap does not invalidate repo cache keys.
export const CROSS_REPO_DISPLAY_LIMIT = 100

// Why: GitHub 422s search pages that start past its 1000-result window.
export const GITHUB_SEARCH_RESULT_WINDOW = 1000

export function taskPageToGitHubApiPage(taskPage: number): number {
  return Math.max(0, Math.floor(taskPage)) + 1
}

// Divide the display budget before fetching: truncated provider rows cannot spill onto another page.
export function getTaskPagePerRepoLimit(
  repoCount: number,
  maxPerRepo: number,
  displayLimit: number
): number {
  const normalizedRepoCount = Math.max(1, Math.floor(repoCount))
  return Math.max(1, Math.min(maxPerRepo, Math.floor(displayLimit / normalizedRepoCount)))
}

// Use the largest repo page count; summed counts/page width undercounts when one repo owns most results.
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
