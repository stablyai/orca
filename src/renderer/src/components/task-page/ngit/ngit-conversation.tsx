import { LoaderCircle } from 'lucide-react'
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { NgitWorkItemDetails } from '../../../../../shared/ngit/ngit-work-item-types'

/** An item's description, patch series and comments. */
export function NgitConversation({
  details,
  error,
  loading
}: {
  details: NgitWorkItemDetails | null
  error: string | null
  loading: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const timestamp = (value: string): string => new Date(value).toLocaleString(intlLocale)
  return (
    <>
      {error ? (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {details?.body ? (
        <CommentMarkdown content={details.body} variant="document" />
      ) : details ? (
        <p className="text-sm text-muted-foreground">
          {t('components.taskPage.ngit.noDescription', 'No description.')}
        </p>
      ) : null}
      {details?.patches.map((patch) => (
        <details key={patch.id} className="rounded-md border border-border/50">
          <summary className="cursor-pointer truncate px-3 py-2 text-xs">
            <span className="font-mono text-muted-foreground">{patch.commit?.slice(0, 8)}</span>{' '}
            {patch.subject}
          </summary>
          <pre className="max-h-96 overflow-auto border-t border-border/50 px-3 py-2 font-mono text-xs scrollbar-sleek">
            {patch.content}
          </pre>
        </details>
      ))}
      {details ? (
        <section className="space-y-3 border-t border-border/40 pt-4">
          {details.comments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('components.taskPage.ngit.noComments', 'No comments yet.')}
            </p>
          ) : (
            details.comments.map((entry) => (
              <article key={entry.id} className="rounded-md border border-border/50">
                <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{entry.author}</span>
                  <span>{timestamp(entry.createdAt)}</span>
                  {entry.replyToId ? (
                    <span>{t('components.taskPage.ngit.reply', 'reply')}</span>
                  ) : null}
                </div>
                <div className="px-3 py-2">
                  <CommentMarkdown content={entry.body} />
                </div>
              </article>
            ))
          )}
        </section>
      ) : loading ? (
        <div className="flex items-center justify-center py-12">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}
    </>
  )
}
