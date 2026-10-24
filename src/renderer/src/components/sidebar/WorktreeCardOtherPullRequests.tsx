import { GitPullRequestArrow } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useNow } from '@/hooks/use-now'
import { formatPrCommentRelativeTime } from '../../../../shared/pr-comment-time'
import type { LinkedPullRequestSummary } from '../../../../shared/github/pull-request-types'

export function WorktreeCardOtherPullRequests({
  pullRequests
}: {
  pullRequests: LinkedPullRequestSummary[] | undefined
}): React.JSX.Element | null {
  const now = useNow(60_000, Boolean(pullRequests?.length))
  if (!pullRequests?.length) {
    return null
  }
  return (
    <div className="space-y-1 rounded-md border border-status-warning-border bg-status-warning-background px-2 py-1.5">
      <div className="flex items-center gap-1 text-[11px] font-medium text-status-warning">
        <GitPullRequestArrow className="size-3" />
        {translate(
          'auto.components.sidebar.WorktreeCardMeta.otherOpenPullRequestsHeading',
          'Other open PRs for this issue'
        )}
      </div>
      {pullRequests.map((pr) => (
        <a
          key={pr.number}
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          title={pr.title}
          className="block truncate text-[11.5px] text-foreground hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {translate(
            'auto.components.sidebar.WorktreeCardMeta.otherOpenPullRequestRow',
            '#{{value0}} by {{value1}}, opened {{value2}}',
            {
              value0: pr.number,
              value1: pr.author,
              value2: formatPrCommentRelativeTime(pr.createdAt, now)
            }
          )}
        </a>
      ))}
    </div>
  )
}
