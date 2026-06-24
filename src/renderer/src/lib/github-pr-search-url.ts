// Why: a director's shipped log records branch names but no PR number/url. To
// link reliably (even after the branch is merged and deleted, and with a cold
// review cache), build a GitHub PR-search URL by head ref — GitHub indexes the
// head ref on the PR, so this resolves the merged PR without knowing its number.

/**
 * Build a GitHub pull-request search URL for a given head branch.
 * @param slug `owner/repo` (from `gh.repoSlug`)
 * @param branch the head branch the PR was opened from
 */
export function buildGithubPrSearchUrl(slug: string, branch: string): string {
  const query = encodeURIComponent(`is:pr head:${branch}`)
  return `https://github.com/${slug}/pulls?q=${query}`
}
