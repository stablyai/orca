import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import type { GiteaComment } from '../../../../shared/gitea/gitea-types'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'

export function GiteaIssueComments({ comments }: { comments: GiteaComment[] }): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <section className="px-4 py-4">
      <div className="mb-3 text-[13px] font-medium text-foreground">
        {t('auto.components.gitea.issue.comments.8608602d16', 'Comments')}
        {comments.length > 0 ? (
          <span className="ml-2 text-[12px] text-muted-foreground">{comments.length}</span>
        ) : null}
      </div>
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('auto.components.gitea.issue.comments.ea3f6f14a1', 'No comments yet.')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {comments.map((comment) => (
            <div key={comment.id} className="rounded-md border border-border/50 bg-muted/20">
              <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
                <span className="truncate text-[13px] font-semibold text-foreground">
                  {comment.user?.login ??
                    t('auto.components.gitea.issue.comments.6a519bdb1c', 'Unknown')}
                </span>
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {formatUiRelativeTimeFromDate(comment.createdAt, undefined, intlLocale)}
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
