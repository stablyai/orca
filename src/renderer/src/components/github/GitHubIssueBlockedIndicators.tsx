import React from 'react'
import { CircleMinus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { GitHubIssueBlockedByRef } from '../../../../shared/github/work-item-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import {
  GITHUB_ISSUE_BLOCKED_ICON_CLASS,
  GITHUB_ISSUE_BLOCKED_LIST_CLASS,
  GITHUB_ISSUE_BLOCKED_PILL_CLASS,
  githubIssueBlockedByCount,
  githubIssueBlockedStatusLabel,
  isGitHubIssueBlocked
} from './github-issue-blocked-presentation'

type BlockedItem = {
  type?: string
  repoId?: string
  blockedByCount?: number
  blockedBy?: readonly GitHubIssueBlockedByRef[]
}

/** List metadata chip: muted "Blocked" + rose icon only (no tooltip), like github.com. */
export function GitHubIssueBlockedListMarker({
  item
}: {
  item: BlockedItem
}): React.JSX.Element | null {
  if (!isGitHubIssueBlocked(item)) {
    return null
  }
  const count = githubIssueBlockedByCount(item)
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1', GITHUB_ISSUE_BLOCKED_LIST_CLASS)}
      aria-label={translate('auto.components.TaskPage.blockedByCount', 'Blocked by {{count}}', {
        count
      })}
    >
      <CircleMinus className={cn('size-3', GITHUB_ISSUE_BLOCKED_ICON_CLASS)} aria-hidden="true" />
      {translate('auto.components.TaskPage.blocked', 'Blocked')}
    </span>
  )
}

function blockedByWorkItemStub(ref: GitHubIssueBlockedByRef, repoId: string): GitHubWorkItem {
  return {
    id: `issue:${ref.number}`,
    type: 'issue',
    number: ref.number,
    title: ref.title || `#${ref.number}`,
    state: 'open',
    url: ref.url || '',
    labels: [],
    updatedAt: new Date(0).toISOString(),
    author: null,
    repoId
  }
}

/** Detail header pill: quiet surface, rose icon, count or single title (navigates in Orca). */
export function GitHubIssueBlockedStatusPill({
  item,
  onOpenWorkItem
}: {
  item: BlockedItem
  onOpenWorkItem?: (item: GitHubWorkItem) => void
}): React.JSX.Element | null {
  if (!isGitHubIssueBlocked(item)) {
    return null
  }
  const { kind, count, title, linkRef } = githubIssueBlockedStatusLabel(item)
  const label =
    kind === 'single'
      ? translate('auto.components.GitHubItemDialog.blockedByTitlePlain', 'Blocked by {{title}}', {
          title: title ?? ''
        })
      : translate('auto.components.TaskPage.blockedByCount', 'Blocked by {{count}}', { count })
  const canNavigate = Boolean(linkRef && item.repoId && onOpenWorkItem)
  const className = cn(
    'inline-flex min-w-0 max-w-[min(100%,28rem)] items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium',
    GITHUB_ISSUE_BLOCKED_PILL_CLASS,
    canNavigate && 'cursor-pointer hover:text-foreground'
  )
  const body = (
    <>
      <CircleMinus
        className={cn('size-3.5 shrink-0', GITHUB_ISSUE_BLOCKED_ICON_CLASS)}
        aria-hidden="true"
      />
      <span className="truncate">{label}</span>
    </>
  )
  if (canNavigate && linkRef && item.repoId && onOpenWorkItem) {
    return (
      <button
        type="button"
        className={className}
        title={label}
        aria-label={label}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onOpenWorkItem(blockedByWorkItemStub(linkRef, item.repoId as string))
        }}
      >
        {body}
      </button>
    )
  }
  return (
    <span className={className} title={label}>
      {body}
    </span>
  )
}
