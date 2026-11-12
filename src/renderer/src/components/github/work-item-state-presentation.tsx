import React from 'react'
import { GitHubUserAvatar } from '@/components/github/github-user-avatar'
import type { GitHubAssignableUser } from '../../../../shared/github/pull-requests/pull-request-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-items/work-item-types'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { getTaskPageGitHubWorkItemStateLabel } from '@/components/task-page/github/task-page-github-work-item-status'
import type { Translate } from '@/i18n/use-translate'

export function formatRelativeTime(input: string, intlLocale?: string): string {
  return formatUiRelativeTimeFromDate(input, undefined, intlLocale)
}

export function getStateLabel(item: GitHubWorkItem, t?: Translate): string {
  return getTaskPageGitHubWorkItemStateLabel(item, t)
}
export function ReviewerAvatar({
  login,
  avatarUrl
}: {
  login: string
  avatarUrl: string
}): React.JSX.Element {
  return <GitHubUserAvatar login={login} avatarUrl={avatarUrl} title={login} className="size-6" />
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
    if (!existing.avatarUrl && user.avatarUrl) {
      byLogin.set(key, { ...existing, avatarUrl: user.avatarUrl })
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
    byLogin.set(key, candidatesByLogin.get(key) ?? { login, name: null, avatarUrl: '' })
  }
  return Array.from(byLogin.values())
}
