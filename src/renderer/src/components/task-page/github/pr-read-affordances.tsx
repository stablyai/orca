import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { isTaskPageGitHubDraftPR } from '@/components/task-page/github/task-page-github-work-item-status'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Mail, MailOpen } from 'lucide-react'

/** Screen-reader name for the row's number pill; unread state rides here so the dot is never color-only. */
export function githubWorkItemPillLabel(item: GitHubWorkItem, isUnreadPR: boolean): string {
  if (item.type !== 'pr') {
    return translate('auto.components.TaskPage.issueNumber', 'Issue #{{number}}', {
      number: item.number
    })
  }
  const number = { number: item.number }
  if (isTaskPageGitHubDraftPR(item)) {
    return isUnreadPR
      ? translate(
          'auto.components.TaskPage.draftPullRequestNumberUnread',
          'Draft pull request #{{number}}, unread',
          number
        )
      : translate(
          'auto.components.TaskPage.draftPullRequestNumber',
          'Draft pull request #{{number}}',
          number
        )
  }
  return isUnreadPR
    ? translate(
        'auto.components.TaskPage.pullRequestNumberUnread',
        'Pull request #{{number}}, unread',
        number
      )
    : translate('auto.components.TaskPage.pullRequestNumber', 'Pull request #{{number}}', number)
}

/** The dot beside the row title: a read PR has none. */
export function PRUnreadDot(): React.JSX.Element {
  return <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" aria-hidden="true" />
}

/** Opening a PR is reading it; the mark still re-raises once the row moves past it. */
export function markPROpened(item: GitHubWorkItem): void {
  useAppStore.getState().markPRsRead([item])
}

/** Flips one PR's read state from the row menu, worded by the state it moves out of. */
export function PRReadMenuItem({
  item,
  isUnreadPR
}: {
  item: GitHubWorkItem
  isUnreadPR: boolean
}): React.JSX.Element {
  return (
    <DropdownMenuItem
      onSelect={() =>
        isUnreadPR
          ? useAppStore.getState().markPRsRead([item])
          : useAppStore.getState().markPRsUnread([item])
      }
    >
      {isUnreadPR ? <MailOpen className="size-4" /> : <Mail className="size-4" />}
      {isUnreadPR
        ? translate('auto.components.TaskPage.markPullRequestRead', 'Mark read')
        : translate('auto.components.TaskPage.markPullRequestUnread', 'Mark unread')}
    </DropdownMenuItem>
  )
}
