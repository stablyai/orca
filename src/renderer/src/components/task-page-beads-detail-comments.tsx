import React, { useCallback, useState } from 'react'
import { LoaderCircle, MessageSquare, Send } from 'lucide-react'
import { toast } from 'sonner'

import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { useAppStore } from '@/store'
import type { BeadsIssueComment, BeadsIssueDetails } from '../../../shared/beads-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

function BeadsCommentCard({ comment }: { comment: BeadsIssueComment }): React.JSX.Element {
  const author =
    comment.author || translate('auto.components.TaskPage.beadsCommentAuthorUnknown', 'unknown')
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border/40 bg-card/50 shadow-xs">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted text-[10px] font-medium text-muted-foreground">
          {author.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">{author}</span>
        <span className="shrink-0 text-[12px] text-muted-foreground">
          · {formatRelativeTime(comment.createdAt)}
        </span>
      </div>
      {/* Why: bd comment text is plain text — render escaped as-is, never as markdown/HTML. */}
      <div className="min-w-0 whitespace-pre-wrap break-words px-3 py-2 text-[13px] leading-relaxed text-foreground">
        {comment.text}
      </div>
    </div>
  )
}

/** Placeholder shown under the description body while comments load. */
export function BeadsItemDetailCommentsSkeleton(): React.JSX.Element {
  return (
    <div data-testid="beads-comments-skeleton" className="mt-4">
      <div className="h-8 w-full animate-pulse rounded-md bg-muted/40" />
    </div>
  )
}

/** GitHub-issue-style comment list + composer wired to the beads details cache. */
export function BeadsItemDetailComments({
  sourceContext,
  issueId,
  details,
  onDetailsChange
}: {
  sourceContext: TaskSourceContext
  issueId: string
  details: BeadsIssueDetails
  onDetailsChange: (details: BeadsIssueDetails) => void
}): React.JSX.Element {
  const addComment = useAppStore((s) => s.addBeadsIssueComment)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const canSubmit = draft.trim().length > 0
  const comments = details.comments
  // Why: a positive count with no entries means bd omitted the array, not an empty thread.
  const commentsOmitted = comments.length === 0 && details.issue.commentCount > 0

  const handleSubmit = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!text || submitting) {
      return
    }
    setSubmitting(true)
    try {
      const refreshed = await addComment(sourceContext, issueId, text)
      setDraft('')
      onDetailsChange(refreshed)
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : translate('auto.components.GitHubItemDialog.082515176a', 'Failed to add comment')
      )
    } finally {
      setSubmitting(false)
    }
  }, [addComment, draft, issueId, onDetailsChange, sourceContext, submitting])

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2 pt-1">
        <MessageSquare className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-medium text-foreground">
          {translate('auto.components.GitHubItemDialog.1506916c09', 'Comments')}
        </span>
        {comments.length > 0 && (
          <span className="rounded-full border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            {comments.length}
          </span>
        )}
      </div>
      {comments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 px-3 py-6 text-left text-[13px] text-muted-foreground">
          {commentsOmitted
            ? translate(
                'auto.components.TaskPage.beadsCommentsUnavailable',
                'Comments could not be loaded.'
              )
            : translate('auto.components.GitHubItemDialog.5a94f3d0e9', 'No comments yet.')}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          {comments.map((comment) => (
            <BeadsCommentCard key={comment.id} comment={comment} />
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={translate('auto.components.GitHubItemDialog.c5c117270e', 'Add a comment…')}
          rows={2}
          disabled={submitting}
          className="min-h-9 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm shadow-xs placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
          onKeyDown={(event) => {
            if (isScreenSubmitShortcut(event) && canSubmit && !submitting) {
              event.preventDefault()
              void handleSubmit()
            }
          }}
        />
        <Button
          size="sm"
          disabled={!canSubmit || submitting}
          onClick={() => void handleSubmit()}
          className="shrink-0 gap-1.5"
        >
          {submitting ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
          {translate('auto.components.GitLabItemDialog.84012fa8fb', 'Comment')}
        </Button>
      </div>
    </div>
  )
}
