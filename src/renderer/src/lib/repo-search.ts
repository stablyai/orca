import type { Repo } from '../../../shared/repo-types'
import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'

// Path scores must exceed every display-name score; choose an offset above realistic display-name lengths.
const PATH_SCORE_OFFSET = 1000
export const REPO_SEARCH_QUERY_MAX_BYTES = 2 * 1024

type RepoMatch = {
  repo: Repo
  score: number
  index: number
}

export function isRepoSearchQueryTooLarge(
  query: string,
  maxBytes = REPO_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

function matchScore(repo: Repo, query: string): number | null {
  const displayNameIndex = repo.displayName.toLowerCase().indexOf(query)
  if (displayNameIndex !== -1) {
    return displayNameIndex
  }

  const pathIndex = repo.path.toLowerCase().indexOf(query)
  if (pathIndex !== -1) {
    // Name hits outrank paths (#379); paths only disambiguate fallback matches.
    return PATH_SCORE_OFFSET + pathIndex
  }

  return null
}

export function searchRepos(repos: readonly Repo[], rawQuery: string): readonly Repo[] {
  if (isRepoSearchQueryTooLarge(rawQuery)) {
    return []
  }
  const trimmedQuery = rawQuery.trim()
  const query = trimmedQuery.toLowerCase()
  if (!query) {
    return repos
  }

  const matches: RepoMatch[] = []
  for (const [index, repo] of repos.entries()) {
    const score = matchScore(repo, query)
    if (score !== null) {
      matches.push({ repo, score, index })
    }
  }

  matches.sort((a, b) => a.score - b.score || a.index - b.index)
  return matches.map((match) => match.repo)
}
