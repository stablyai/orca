import React from 'react'
import { ExternalLink, MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import {
  PR_COMMENT_OPEN_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_CONTAINER_CLASS
} from '@/lib/pr-comment-resolution-classes'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import { CommentCodeContext } from '@/components/github/CommentCodeContext'
import { CommentReactions } from '@/components/github/CommentReactions'
import { translate } from '@/i18n/i18n'
import type { GitHubOwnerRepo, GitHubPRFile } from '../../../../../shared/github/pull-request-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { MentionOption } from '../page-types'
import { loadPRFileContents } from '../cache/file-content'
import { CommentReplyForm } from '../comments/reply-form'

export function ConversationCommentCard({
  comment,
  isReply = false,
  repoPath,
  repoId,
  sourceContext,
  prNumber,
  prRepo,
  files,
  headSha,
  baseSha,
  markdownGitHubRepo,
  mentionOptions,
  resolvedReplyingTo,
  onToggleReply,
  onSubmitReply
}: {
  comment: PRComment
  isReply?: boolean
  repoPath: string | null
  repoId: string
  sourceContext?: TaskSourceContext | null
  prNumber: number
  prRepo: GitHubOwnerRepo | null
  files: GitHubPRFile[]
  headSha: string | undefined
  baseSha: string | undefined
  markdownGitHubRepo: { owner: string; repo: string; host?: string } | null
  mentionOptions: MentionOption[]
  resolvedReplyingTo: number | null
  onToggleReply: (commentId: number) => void
  onSubmitReply: (comment: PRComment, replyBody: string) => Promise<boolean>
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'min-w-0 overflow-hidden rounded-lg border border-border/40 bg-card shadow-xs',
        isReply && 'ml-6 max-w-[calc(100%-1.5rem)]',
        comment.isResolved && PR_COMMENT_RESOLVED_CONTAINER_CLASS
      )}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
        {comment.authorAvatarUrl ? (
          <img
            src={comment.authorAvatarUrl}
            alt={comment.author}
            className="size-5 shrink-0 rounded-full"
          />
        ) : (
          <div className="size-5 shrink-0 rounded-full bg-muted" />
        )}
        <span
          className={cn(
            'min-w-0 truncate text-[13px] font-semibold',
            comment.isResolved ? PR_COMMENT_RESOLVED_AUTHOR_CLASS : PR_COMMENT_OPEN_AUTHOR_CLASS
          )}
        >
          {comment.author}
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground">
          · {formatRelativeTime(comment.createdAt)}
        </span>
        {comment.path && (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">
            {comment.path.split('/').pop()}
            {comment.line
              ? translate('auto.components.PullRequestPage.34b9f7c264', ':L{{value0}}', {
                  value0: comment.line
                })
              : ''}
          </span>
        )}
        {comment.isResolved && (
          <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {translate('auto.components.PullRequestPage.76b2a0ac5b', 'resolved')}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-7"
                onClick={() => onToggleReply(comment.id)}
                aria-label={translate(
                  'auto.components.PullRequestPage.d6c6679de7',
                  'Reply to comment'
                )}
              >
                <MessageSquarePlus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {translate('auto.components.PullRequestPage.d6c6679de7', 'Reply to comment')}
            </TooltipContent>
          </Tooltip>
          {comment.url && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-7"
                  onClick={() => window.api.shell.openUrl(comment.url)}
                  aria-label={translate(
                    'auto.components.PullRequestPage.0ac19bb52e',
                    'Open comment on GitHub'
                  )}
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {translate('auto.components.PullRequestPage.0ac19bb52e', 'Open comment on GitHub')}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="min-w-0 px-3 py-2">
        <CommentCodeContext
          comment={comment}
          repoPath={repoPath}
          repoId={repoId}
          sourceContext={sourceContext}
          prNumber={prNumber}
          prRepo={prRepo}
          files={files}
          headSha={headSha}
          baseSha={baseSha}
          loadPRFileContents={loadPRFileContents}
        />
        <CommentMarkdown
          content={comment.body}
          variant="document"
          githubRepo={markdownGitHubRepo}
          className="min-w-0 max-w-full overflow-hidden break-words text-[13px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
        />
        <CommentReactions reactions={comment.reactions} />
        {resolvedReplyingTo === comment.id && (
          <CommentReplyForm
            className="mt-3"
            placeholder={
              comment.path
                ? translate(
                    'auto.components.PullRequestPage.408e634fbb',
                    'Reply in this review thread'
                  )
                : translate('auto.components.PullRequestPage.31a7b202f2', 'Reply to @{{value0}}', {
                    value0: comment.author
                  })
            }
            mentionOptions={mentionOptions}
            onCancel={() => onToggleReply(comment.id)}
            onSubmit={(replyBody) => onSubmitReply(comment, replyBody)}
          />
        )}
      </div>
    </div>
  )
}
