import { GitMerge } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useNow } from '@/hooks/use-now'
import { formatPrCommentRelativeTime } from '../../../../shared/pr-comment-time'
import type { RelandedPullRequestSummary } from '../../../../shared/github/pull-request-types'

export function WorktreeCardRelandedIn({
  pullRequests
}: {
  pullRequests: RelandedPullRequestSummary[] | undefined
}): React.JSX.Element | null {
  const now = useNow(60_000, Boolean(pullRequests?.length))
  if (!pullRequests?.length) {
    return null
  }
  return (
    <div className="space-y-1 rounded-md border border-border bg-muted/40 px-2 py-1.5">
      <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
        <GitMerge className="size-3" />
        {translate('auto.components.sidebar.WorktreeCardMeta.relandedInHeading', 'Re-landed in')}
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
            'auto.components.sidebar.WorktreeCardMeta.relandedInRow',
            '#{{value0}} by {{value1}}, merged {{value2}}',
            {
              value0: pr.number,
              value1: pr.author,
              value2: formatPrCommentRelativeTime(pr.mergedAt, now)
            }
          )}
        </a>
      ))}
    </div>
  )
}
