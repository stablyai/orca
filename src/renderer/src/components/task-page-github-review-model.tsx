import type {
  GitHubOwnerRepo,
  GitHubAssignableUser
} from '../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import { parseGitHubIssueOrPRLink } from '@/lib/github-links'
import { githubProjectHost } from '../../../shared/github/project-identity'
export function sameOptionalGitHubOwnerRepo(
  left: GitHubOwnerRepo | null | undefined,
  right: GitHubOwnerRepo | null | undefined
): boolean {
  const leftValue = left ?? null
  const rightValue = right ?? null
  return leftValue === null && rightValue === null
    ? true
    : sameGitHubOwnerRepo(leftValue, rightValue)
}

// Why: URL fallback preserves enterprise hosts before prRepo hydrates.
export function resolveTaskPullRequestRepo(
  item: Pick<GitHubWorkItem, 'prRepo' | 'url'>
): GitHubOwnerRepo | null {
  const repo = item.prRepo ?? parseGitHubIssueOrPRLink(item.url)?.slug ?? null
  return repo
    ? {
        ...repo,
        host: githubProjectHost(repo.host)
      }
    : null
}
export function mergeReviewerSuggestions(
  users: GitHubAssignableUser[],
  seedUsers: GitHubAssignableUser[]
): GitHubAssignableUser[] {
  const byLogin = new Map<string, GitHubAssignableUser>()
  for (const user of [...seedUsers, ...users]) {
    const key = user.login.toLowerCase()
    const existing = byLogin.get(key)
    if (!existing) {
      byLogin.set(key, user)
      continue
    }
    // Why: seeds carry login only; backfill display fields from the metadata query.
    if ((!existing.avatarUrl && user.avatarUrl) || (!existing.name && user.name)) {
      byLogin.set(key, {
        ...existing,
        avatarUrl: existing.avatarUrl || user.avatarUrl,
        name: existing.name ?? user.name
      })
    }
  }
  return Array.from(byLogin.values()).sort((a, b) => a.login.localeCompare(b.login))
}
export function buildRequestedReviewUsers(
  logins: string[],
  candidates: GitHubAssignableUser[],
  existingRequests: GitHubAssignableUser[]
): GitHubAssignableUser[] {
  const byLogin = new Map<string, GitHubAssignableUser>()
  for (const user of existingRequests) {
    byLogin.set(user.login.toLowerCase(), user)
  }
  const candidatesByLogin = new Map(candidates.map((user) => [user.login.toLowerCase(), user]))
  for (const login of logins) {
    const key = login.toLowerCase()
    if (byLogin.has(key)) {
      continue
    }
    byLogin.set(
      key,
      candidatesByLogin.get(key) ?? {
        login,
        name: null,
        avatarUrl: ''
      }
    )
  }
  return Array.from(byLogin.values())
}
