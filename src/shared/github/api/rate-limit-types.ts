/** Task header quota snapshots cover REST core, work-item search and Project GraphQL usage so users can see remaining budget.
 * Other buckets such as code_search are unused and omitted; actual limits come from each bucket. */
export type GitHubRateLimitBucket = {
  remaining: number
  limit: number
  /** Unix epoch seconds when the window resets. */
  resetAt: number
}

export type GitHubRateLimitSnapshot = {
  core: GitHubRateLimitBucket
  search: GitHubRateLimitBucket
  graphql: GitHubRateLimitBucket
  /** Unix epoch ms the snapshot was produced (for "fetched Xs ago" copy). */
  fetchedAt: number
}

export type GetRateLimitResult =
  | { ok: true; snapshot: GitHubRateLimitSnapshot }
  | { ok: false; error: string }
