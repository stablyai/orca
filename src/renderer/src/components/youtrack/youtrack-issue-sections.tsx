import {
  CheckCircle2,
  CircleDashed,
  LoaderCircle,
  OctagonAlert,
  RefreshCw,
  Send
} from 'lucide-react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { cn } from '@/lib/utils'
import type {
  YouTrackComment,
  YouTrackIssue,
  YouTrackLinkGroup
} from '../../../../shared/youtrack-types'

function LinkGroup({
  group,
  onOpenIssue
}: {
  group: YouTrackLinkGroup
  onOpenIssue: (idReadable: string) => void
}): React.JSX.Element {
  const blockedBy = group.blocking === 'blocked-by'
  const openBlockers = blockedBy ? group.issues.filter((issue) => !issue.resolved).length : 0
  return (
    <div
      className={cn(
        'rounded-md border border-border/50',
        openBlockers > 0 && 'border-destructive/30 bg-destructive/5'
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
        {openBlockers > 0 ? <OctagonAlert className="size-3.5 text-destructive" /> : null}
        <span className="text-[12px] font-medium capitalize text-foreground">{group.label}</span>
        <span className="text-[11px] text-muted-foreground">{group.issues.length}</span>
      </div>
      <ul className="divide-y divide-border/40">
        {group.issues.map((linked) => (
          <li key={linked.id}>
            <button
              type="button"
              onClick={() => onOpenIssue(linked.idReadable)}
              className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-[12px] transition hover:bg-accent/60"
            >
              {linked.resolved ? (
                <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <CircleDashed
                  className={cn(
                    'size-3.5 shrink-0',
                    blockedBy ? 'text-destructive' : 'text-muted-foreground'
                  )}
                />
              )}
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {linked.idReadable}
              </span>
              <span
                className={cn(
                  'truncate text-foreground',
                  linked.resolved && 'text-muted-foreground line-through'
                )}
              >
                {linked.summary}
              </span>
              {linked.state ? (
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  {linked.state}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function YouTrackLinksSection({
  issue,
  onOpenIssue
}: {
  issue: YouTrackIssue
  onOpenIssue: (idReadable: string) => void
}): React.JSX.Element | null {
  if (issue.links.length === 0) {
    return null
  }
  return (
    <section className="border-b border-border/40 px-4 py-4">
      <div className="mb-2 text-[13px] font-medium text-foreground">
        {translate('youtrack.detail.links', 'Links')}
      </div>
      <div className="grid gap-2">
        {issue.links.map((group) => (
          <LinkGroup
            key={`${group.linkTypeName}:${group.label}`}
            group={group}
            onOpenIssue={onOpenIssue}
          />
        ))}
      </div>
    </section>
  )
}

export function YouTrackCommentsSection({
  comments,
  loading,
  error,
  onRetry
}: {
  comments: YouTrackComment[]
  loading: boolean
  error: string | null
  onRetry: () => void
}): React.JSX.Element {
  return (
    <section className="px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-foreground">
            {translate('youtrack.detail.comments', 'Comments')}
          </span>
          {comments.length > 0 ? (
            <span className="text-[12px] text-muted-foreground">{comments.length}</span>
          ) : null}
        </div>
        {error ? (
          <Button variant="outline" size="xs" onClick={onRetry} disabled={loading}>
            {loading ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {translate('youtrack.detail.retry', 'Retry')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : loading && comments.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate('youtrack.detail.noComments', 'No comments yet.')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {comments.map((comment) => (
            <div key={comment.id} className="rounded-md border border-border/50 bg-muted/20">
              <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
                <span className="truncate text-[13px] font-semibold text-foreground">
                  {comment.author?.fullName ??
                    translate('youtrack.detail.unknownAuthor', 'Unknown')}
                </span>
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {formatUiRelativeTimeFromDate(comment.createdAt)}
                </span>
              </div>
              <div className="px-3 py-2">
                <CommentMarkdown content={comment.text} className="text-[13px] leading-relaxed" />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export function YouTrackCommentComposer({
  draft,
  setDraft,
  submitting,
  onSubmit
}: {
  draft: string
  setDraft: (value: string) => void
  submitting: boolean
  onSubmit: () => void
}): React.JSX.Element {
  return (
    <div className="flex-none border-t border-border/50 bg-background px-3 py-3">
      <div className="flex gap-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            const submitModifier = navigator.userAgent.includes('Mac')
              ? event.metaKey
              : event.ctrlKey
            if (event.key === 'Enter' && submitModifier) {
              event.preventDefault()
              onSubmit()
            }
          }}
          placeholder={translate('youtrack.detail.commentPlaceholder', 'Add a comment (Markdown)…')}
          rows={2}
          disabled={submitting}
          className="min-h-10 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Button onClick={onSubmit} disabled={!draft.trim() || submitting} className="self-end">
          {submitting ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          {translate('youtrack.detail.comment', 'Comment')}
        </Button>
      </div>
    </div>
  )
}
