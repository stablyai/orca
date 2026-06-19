import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { GiteaComment } from '../../../shared/types'
import { translate } from '@/i18n/i18n'

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function formatRelativeTime(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return 'recently'
  }
  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60_000)
  if (Math.abs(diffMinutes) < 60) {
    return relativeFormatter.format(diffMinutes, 'minute')
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return relativeFormatter.format(diffHours, 'hour')
  }
  return relativeFormatter.format(Math.round(diffHours / 24), 'day')
}

export function GiteaIssueComments({ comments }: { comments: GiteaComment[] }): React.JSX.Element {
  return (
    <section className="px-4 py-4">
      <div className="mb-3 text-[13px] font-medium text-foreground">
        {translate('auto.components.gitea.issue.comments.8608602d16', 'Comments')}
        {comments.length > 0 ? (
          <span className="ml-2 text-[12px] text-muted-foreground">{comments.length}</span>
        ) : null}
      </div>
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate('auto.components.gitea.issue.comments.ea3f6f14a1', 'No comments yet.')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {comments.map((comment) => (
            <div key={comment.id} className="rounded-md border border-border/50 bg-muted/20">
              <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
                <span className="truncate text-[13px] font-semibold text-foreground">
                  {comment.user?.login ??
                    translate('auto.components.gitea.issue.comments.6a519bdb1c', 'Unknown')}
                </span>
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {formatRelativeTime(comment.createdAt)}
                </span>
              </div>
              <div className="px-3 py-2">
                <CommentMarkdown content={comment.body} className="text-[13px] leading-relaxed" />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
