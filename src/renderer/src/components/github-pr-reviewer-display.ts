import type { GitHubAssignableUser, GitHubWorkItem } from '../../../shared/types'

type ReviewDisplayItem = Pick<GitHubWorkItem, 'reviewDecision' | 'reviewRequests' | 'latestReviews'>
export type GitHubPRPrimaryReviewer = Pick<GitHubAssignableUser, 'login' | 'avatarUrl'> & {
  name?: string | null
}
export type GitHubPRReviewerRow = GitHubPRPrimaryReviewer & {
  stateLabel: string
}

function uniqueLogins(logins: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const login of logins) {
    const trimmed = login?.trim()
    if (!trimmed) {
      continue
    }
    const key = trimmed.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

export function normalizeGitHubReviewerLogins(
  logins: readonly string[],
  excludedLogins: ReadonlySet<string> = new Set()
): string[] {
  return uniqueLogins(logins.map((login) => login.trim().replace(/^@/, ''))).filter(
    (login) => !excludedLogins.has(login.toLowerCase())
  )
}

function formatReviewerLogins(logins: readonly string[]): string | null {
  if (logins.length === 0) {
    return null
  }
  if (logins.length === 1) {
    return logins[0]
  }
  return `${logins[0]} +${logins.length - 1}`
}

function formatReviewState(state: string | null | undefined): string {
  switch (state) {
    case 'APPROVED':
      return 'Approved'
    case 'CHANGES_REQUESTED':
      return 'Changes requested'
    case 'COMMENTED':
      return 'Commented'
    case 'DISMISSED':
      return 'Dismissed'
    case 'PENDING':
      return 'Pending'
    case null:
    case undefined:
    default:
      return 'Reviewed'
  }
}

export function getGitHubPRReviewLabel(item: ReviewDisplayItem): string {
  if (
    item.reviewDecision === undefined &&
    item.reviewRequests === undefined &&
    item.latestReviews === undefined
  ) {
    return 'Reviewers'
  }
  if (item.reviewDecision === 'APPROVED') {
    return 'Approved'
  }
  if (item.reviewDecision === 'CHANGES_REQUESTED') {
    return 'Changes requested'
  }
  const requestedLabel = formatReviewerLogins(
    uniqueLogins((item.reviewRequests ?? []).map((user) => user.login))
  )
  if (requestedLabel) {
    return requestedLabel
  }
  const reviewedLabel = formatReviewerLogins(
    uniqueLogins((item.latestReviews ?? []).map((review) => review.login))
  )
  if (reviewedLabel) {
    return reviewedLabel
  }
  return 'No reviewers'
}

export function getGitHubPRPrimaryReviewer(
  item: ReviewDisplayItem
): GitHubPRPrimaryReviewer | null {
  const requested = (item.reviewRequests ?? []).find((user) => user.login.trim())
  if (requested) {
    return requested
  }
  const reviewed = (item.latestReviews ?? []).find((review) => review.login.trim())
  if (reviewed) {
    return {
      login: reviewed.login,
      avatarUrl: reviewed.avatarUrl ?? '',
      name: null
    }
  }
  return null
}

export function getGitHubPRReviewerRows(item: ReviewDisplayItem): GitHubPRReviewerRow[] {
  const byLogin = new Map<string, GitHubPRReviewerRow>()
  for (const user of item.reviewRequests ?? []) {
    const login = user.login.trim()
    if (!login) {
      continue
    }
    byLogin.set(login.toLowerCase(), {
      login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      stateLabel: 'Requested'
    })
  }
  for (const review of item.latestReviews ?? []) {
    const login = review.login.trim()
    const key = login.toLowerCase()
    if (!login || byLogin.has(key)) {
      continue
    }
    byLogin.set(key, {
      login,
      name: null,
      avatarUrl: review.avatarUrl ?? '',
      stateLabel: formatReviewState(review.state)
    })
  }
  return Array.from(byLogin.values())
}

export function appendGitHubPRRequestedReviewers(
  current: readonly GitHubAssignableUser[],
  logins: readonly string[]
): GitHubAssignableUser[] {
  const byLogin = new Map<string, GitHubAssignableUser>()
  for (const user of current) {
    const login = user.login.trim()
    if (login) {
      byLogin.set(login.toLowerCase(), user)
    }
  }
  for (const rawLogin of logins) {
    const login = rawLogin.trim().replace(/^@/, '')
    if (!login) {
      continue
    }
    const key = login.toLowerCase()
    if (!byLogin.has(key)) {
      byLogin.set(key, { login, name: null, avatarUrl: '' })
    }
  }
  return Array.from(byLogin.values())
}
