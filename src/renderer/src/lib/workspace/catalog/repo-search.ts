import type { Repo } from '../../../../../shared/repository/repo-types'
import { isClipboardTextByteLengthOverLimit } from '../../../../../shared/clipboard/clipboard-text'
import { compileRepoSearchPattern, type RepoSearchPattern } from './repo-search-pattern'

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

function matchScore(repo: Repo, match: RepoSearchPattern): number | null {
  const displayNameIndex = match(repo.displayName.toLowerCase())
  if (displayNameIndex !== -1) {
    return displayNameIndex
  }

  const pathIndex = match(repo.path.toLowerCase())
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

  const match = compileRepoSearchPattern(query)
  const matches: RepoMatch[] = []
  for (const [index, repo] of repos.entries()) {
    const score = matchScore(repo, match)
    if (score !== null) {
      matches.push({ repo, score, index })
    }
  }

  matches.sort((a, b) => a.score - b.score || a.index - b.index)
  return matches.map((match) => match.repo)
}
