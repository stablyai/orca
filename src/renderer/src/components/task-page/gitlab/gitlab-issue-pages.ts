/** Pager state derived from one settled round of per-repo GitLab issue requests. */
export type GitLabIssuePageState = {
  /** 0-based page to show — below the requested one when the requested page overshot the list. */
  page: number
  /** null keeps the current pager size: a failed load is not evidence of the end of the list. */
  totalPages: number | null
}

export function resolveGitLabIssuePageState(args: {
  requestedPage: number
  errorCount: number
  results: readonly { items: readonly unknown[]; totalPages?: number }[]
}): GitLabIssuePageState {
  const itemCount = args.results.reduce((total, result) => total + result.items.length, 0)
  // null distinguishes "no repo reported a count" from "every repo reported one page".
  const reported = args.results.reduce<number | null>(
    (maximum, result) =>
      typeof result.totalPages === 'number' && Number.isFinite(result.totalPages)
        ? Math.max(maximum ?? 1, Math.floor(result.totalPages))
        : maximum,
    null
  )
  // Why: a proxy that strips x-total makes the host advertise one speculative next page (#13357),
  // and issues can close under a deep page — either way an empty, error-free page past the first
  // means we overshot. Trust a reported count so we land on the last page in one hop instead of
  // re-fetching every page on the way back.
  if (args.requestedPage > 0 && itemCount === 0 && args.errorCount === 0) {
    const totalPages =
      reported === null ? args.requestedPage : Math.min(args.requestedPage, reported)
    return { page: totalPages - 1, totalPages }
  }
  if (itemCount === 0 && args.errorCount > 0) {
    return { page: args.requestedPage, totalPages: null }
  }
  // Why: rows on page N prove at least N+1 pages exist — without the floor a host that
  // under-reports (or omits) the count would hide the pager and strand the user on a deep page.
  return {
    page: args.requestedPage,
    totalPages: Math.max(reported ?? 1, args.requestedPage + 1)
  }
}
