import type { GitHubIssueBlockedByRef } from '../../../../shared/github/work-item-types'

/** Quiet chip: page-background fill, muted label, rose icon only. */
export const GITHUB_ISSUE_BLOCKED_LIST_CLASS =
  'rounded-full border border-border/60 bg-background px-1.5 py-0 text-[11px] font-medium text-muted-foreground'

/** Detail header pill — same quiet surface as the list chip. */
export const GITHUB_ISSUE_BLOCKED_PILL_CLASS =
  'max-w-full border border-border/60 bg-background text-muted-foreground'

export const GITHUB_ISSUE_BLOCKED_ICON_CLASS = 'text-rose-600 dark:text-rose-400'

export function githubIssueBlockedByCount(item: {
  blockedByCount?: number
  blockedBy?: readonly GitHubIssueBlockedByRef[]
}): number {
  if (typeof item.blockedByCount === 'number') {
    return item.blockedByCount
  }
  return item.blockedBy?.length ?? 0
}

export function githubIssuePrimaryBlockedByRef(item: {
  blockedBy?: readonly GitHubIssueBlockedByRef[]
}): GitHubIssueBlockedByRef | null {
  return item.blockedBy?.[0] ?? null
}

export function isGitHubIssueBlocked(item: {
  type?: string
  blockedByCount?: number
  blockedBy?: readonly GitHubIssueBlockedByRef[]
}): boolean {
  return item.type === 'issue' && githubIssueBlockedByCount(item) > 0
}

/** Single blocker → title (linkable); multiple → count only. */
export function githubIssueBlockedStatusLabel(item: {
  blockedByCount?: number
  blockedBy?: readonly GitHubIssueBlockedByRef[]
}): {
  kind: 'single' | 'count'
  count: number
  title: string | null
  linkRef: GitHubIssueBlockedByRef | null
} {
  const count = githubIssueBlockedByCount(item)
  const primary = githubIssuePrimaryBlockedByRef(item)
  if (count === 1 && primary) {
    return {
      kind: 'single',
      count,
      title: primary.title?.trim() ? primary.title : `#${primary.number}`,
      linkRef: primary
    }
  }
  return { kind: 'count', count, title: null, linkRef: null }
}
