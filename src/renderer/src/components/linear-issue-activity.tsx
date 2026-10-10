import React from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'

import { LinearIssueCommentFooter, type LinearLocalComment } from '@/components/LinearItemDrawer'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { formatLinearIssueRelativeTime } from '@/components/linear-issue-workspace-text'
import type { LinearComment, LinearIssue } from '../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

function LinearIssueAvatar({
  avatarUrl,
  name,
  className = 'size-6'
}: {
  avatarUrl?: string
  name?: string
  className?: string
}): React.JSX.Element {
  if (avatarUrl) {
    return <img src={avatarUrl} alt={name ?? ''} className={`${className} shrink-0 rounded-full`} />
  }
  const initial = name?.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className={`${className} flex shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground`}
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}

export function LinearIssueActivity({
  issue,
  comments,
  commentsLoading,
  commentsError,
  onRetryComments,
  onCommentAdded,
  sourceContext
}: {
  issue: LinearIssue
  comments: LinearComment[]
  commentsLoading: boolean
  commentsError: string | null
  onRetryComments: () => Promise<void>
  onCommentAdded: (comment: LinearLocalComment) => void
  sourceContext?: TaskSourceContext | null
}): React.JSX.Element {
  return (
    <section className="mt-12 border-t border-border/60 pt-9">
      <div className="mb-8 flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-foreground">
          {translate('auto.components.LinearIssueWorkspace.543970c87a', 'Activity')}
        </h2>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <LinearIssueAvatar
            avatarUrl={issue.assignee?.avatarUrl}
            name={issue.assignee?.displayName}
            className="size-6"
          />
        </div>
      </div>

      <div className="mb-7 flex items-center gap-3 text-sm text-muted-foreground">
        <LinearIssueAvatar
          avatarUrl={issue.assignee?.avatarUrl}
          name={issue.assignee?.displayName}
          className="size-5"
        />
        <span>
          {issue.assignee?.displayName ??
            translate('auto.components.LinearIssueWorkspace.8a33c85e9c', 'Someone')}{' '}
          {translate('auto.components.LinearIssueWorkspace.fabbd3f974', 'updated the issue ·')}{' '}
          {formatLinearIssueRelativeTime(issue.updatedAt)}
        </span>
      </div>

      {commentsError ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>{commentsError}</span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void onRetryComments()}
            disabled={commentsLoading}
            className="gap-1"
          >
            {commentsLoading ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {translate('auto.components.LinearIssueWorkspace.b0eac92d85', 'Retry')}
          </Button>
        </div>
      ) : null}

      {commentsLoading && comments.length === 0 ? (
        <div className="mb-5 flex items-center justify-center py-8">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : comments.length > 0 ? (
        <div className="mb-6 flex flex-col gap-5">
          {comments.map((comment) => (
            <article key={comment.id} className="flex gap-3">
              <LinearIssueAvatar
                avatarUrl={comment.user?.avatarUrl}
                name={comment.user?.displayName}
                className="size-7"
              />
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex min-w-0 items-center gap-2 text-sm">
                  <span className="truncate font-semibold text-foreground">
                    {comment.user?.displayName ??
                      translate('auto.components.LinearIssueWorkspace.ca8778c124', 'Unknown')}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {formatLinearIssueRelativeTime(comment.createdAt)}
                  </span>
                </div>
                <div className="rounded-lg border border-border/60 bg-card px-4 py-3">
                  <CommentMarkdown content={comment.body} className="text-[14px] leading-7" />
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      <LinearIssueCommentFooter
        issueId={issue.id}
        workspaceId={issue.workspaceId}
        onCommentAdded={onCommentAdded}
        variant="linear-page"
        sourceContext={sourceContext}
      />
    </section>
  )
}
