import { githubCommentImageUploadAddress } from '@/components/github/github-comment-image-upload-address'
import React from 'react'
import { ExternalLink, MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/class-names'
import {
  PR_COMMENT_OPEN_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_CONTAINER_CLASS
} from '@/lib/source-control/review/comments/pr-comment-resolution-classes'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import { CommentCodeContext } from '@/components/github/CommentCodeContext'
import { CommentReactions } from '@/components/github/CommentReactions'
import { GitHubUserAvatar } from '@/components/github/github-user-avatar'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../../shared/github/repositories/repository-identity'
import type { GitHubPRFile } from '../../../../../shared/github/pull-requests/pull-request-types'
import type { PRComment } from '../../../../../shared/github/comments/comment-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import type { MentionOption } from '../page-types'
import { loadPRFileContents } from '../cache/file-content'
import { CommentReplyForm } from '../comments/reply-form'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

export function ConversationCommentCard({
  comment,
  isReply = false,
  repoPath,
  itemType,
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
  itemType: 'issue' | 'pr'
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
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <div
      className={cn(
        'min-w-0 overflow-hidden rounded-lg border border-border/40 bg-card shadow-xs',
        isReply && 'ml-6 max-w-[calc(100%-1.5rem)]',
        comment.isResolved && PR_COMMENT_RESOLVED_CONTAINER_CLASS
      )}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
        <GitHubUserAvatar
          login={comment.author}
          avatarUrl={comment.authorAvatarUrl}
          title={comment.author}
          className="size-5"
        />
        <span
          className={cn(
            'min-w-0 truncate text-[13px] font-semibold',
            comment.isResolved ? PR_COMMENT_RESOLVED_AUTHOR_CLASS : PR_COMMENT_OPEN_AUTHOR_CLASS
          )}
        >
          {comment.author}
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground">
          · {formatRelativeTime(comment.createdAt, intlLocale)}
        </span>
        {comment.path && (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">
            {comment.path.split('/').pop()}
            {comment.line
              ? t('auto.components.PullRequestPage.34b9f7c264', ':L{{value0}}', {
                  value0: comment.line
                })
              : ''}
          </span>
        )}
        {comment.isResolved && (
          <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {t('auto.components.PullRequestPage.76b2a0ac5b', 'resolved')}
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
                aria-label={t('auto.components.PullRequestPage.d6c6679de7', 'Reply to comment')}
              >
                <MessageSquarePlus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t('auto.components.PullRequestPage.d6c6679de7', 'Reply to comment')}
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
                  onClick={(event) => openAppHttpLink(comment.url, { event })}
                  aria-label={t(
                    'auto.components.PullRequestPage.0ac19bb52e',
                    'Open comment on GitHub'
                  )}
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t('auto.components.PullRequestPage.0ac19bb52e', 'Open comment on GitHub')}
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
          bodyImageUrls={comment.bodyImageUrls}
          variant="document"
          githubRepo={markdownGitHubRepo}
          className="min-w-0 max-w-full overflow-hidden break-words text-[13px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
        />
        <CommentReactions reactions={comment.reactions} />
        {resolvedReplyingTo === comment.id && (
          <CommentReplyForm
            imageUploadAddress={githubCommentImageUploadAddress({
              repoPath: repoPath ?? '',
              repoId,
              sourceContext,
              type: itemType,
              prRepo
            })}
            className="mt-3"
            placeholder={
              comment.path
                ? t('auto.components.PullRequestPage.408e634fbb', 'Reply in this review thread')
                : t('auto.components.PullRequestPage.31a7b202f2', 'Reply to @{{value0}}', {
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
