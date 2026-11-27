import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { isScreenSubmitShortcut } from '@/lib/keyboard/screen-submit-shortcut'
import type { ItsaplanComment } from '../../../shared/itsaplan/itsaplan-types'
import { formatRelativeTime } from './task-page/task-page-source-context'

export function ItsaplanIssueComments({
  issueId,
  projectRef,
  comments
}: {
  issueId: number
  projectRef: string
  comments: readonly ItsaplanComment[]
}): React.JSX.Element {
  const t = useTranslate()
  const addItsaplanComment = useAppStore((s) => s.addItsaplanComment)
  const loadItsaplanIssueDetail = useAppStore((s) => s.loadItsaplanIssueDetail)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submit = (): void => {
    const body = draft.trim()
    if (!body || submitting) {
      return
    }
    setSubmitting(true)
    void addItsaplanComment(issueId, body)
      .then((result) => {
        if (!result.ok) {
          toast.error(result.message)
          return
        }
        setDraft('')
        return loadItsaplanIssueDetail(issueId, { force: true, projectRef }).then(() => undefined)
      })
      .catch(() => {
        toast.error(t('taskProviders.itsaplan.commentFailed', 'Failed to add the comment.'))
      })
      .finally(() => setSubmitting(false))
  }
  return (
    <section className="mt-12 border-t border-border/60 pt-9">
      <h2 className="mb-6 text-xl font-semibold text-foreground">
        {t('taskProviders.itsaplan.comments', 'Comments')}
      </h2>
      {comments.length > 0 ? (
        <div className="mb-6 flex flex-col gap-5">
          {comments.map((comment) => (
            <article key={comment.id} className="min-w-0">
              <div className="mb-1 flex min-w-0 items-center gap-2 text-sm">
                <span className="truncate font-semibold text-foreground">
                  {comment.author?.name ??
                    t('auto.components.LinearIssueWorkspace.ca8778c124', 'Unknown')}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {formatRelativeTime(comment.createdAt)}
                </span>
              </div>
              <div className="rounded-lg border border-border/60 bg-card px-4 py-3">
                <CommentMarkdown content={comment.body} className="text-[14px] leading-7" />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="mb-6 text-sm text-muted-foreground">
          {t('taskProviders.itsaplan.noComments', 'No comments yet.')}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (isScreenSubmitShortcut(event)) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={t('taskProviders.itsaplan.commentPlaceholder', 'Leave a comment...')}
          disabled={submitting}
          rows={3}
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={submit} disabled={!draft.trim() || submitting}>
            {submitting ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
            {t('taskProviders.itsaplan.addComment', 'Comment')}
          </Button>
        </div>
      </div>
    </section>
  )
}
