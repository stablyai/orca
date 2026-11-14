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
import type { PRComment } from '../../../../../shared/github/comments/comment-types'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../../shared/github/repositories/repository-identity'
import type { GitHubPRFile } from '../../../../../shared/github/pull-requests/pull-request-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { loadPRFileContents } from '../load-item-details/pr-file-content-cache'
import { CommentReplyForm } from './comment-reply-form'
import { githubCommentImageUploadAddress } from '@/components/github/github-comment-image-upload-address'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

export type ConversationCommentCardContext = {
  repoPath: string | null
  repoId: string | undefined
  sourceContext?: TaskSourceContext | null
  itemType: 'issue' | 'pr'
  prNumber: number
  prRepo: GitHubOwnerRepo | null
  files: GitHubPRFile[]
  headSha: string | undefined
  baseSha: string | undefined
  markdownGitHubRepo: GitHubOwnerRepo | null
  resolvedReplyingTo: number | null
  setReplyingTo: React.Dispatch<React.SetStateAction<number | null>>
  handleReply: (comment: PRComment, replyBody: string) => Promise<boolean>
}

export function renderCommentCard(
  comment: PRComment,
  isReply = false,
  ctx: ConversationCommentCardContext,
  t: Translate = translate,
  intlLocale?: string
): React.JSX.Element {
  return (
    <div
      key={comment.id}
      className={cn(
        'min-w-0 overflow-hidden rounded-lg border border-border/40 bg-card/50 shadow-xs',
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
          · {formatRelativeTime(comment.createdAt, intlLocale)}
        </span>
        {comment.path && (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">
            {comment.path.split('/').pop()}
            {comment.line
              ? t('auto.components.GitHubItemDialog.136542c9ba', ':L{{value0}}', {
                  value0: comment.line
                })
              : ''}
          </span>
        )}
        {comment.isResolved && (
          <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {t('auto.components.GitHubItemDialog.68cb993d61', 'resolved')}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-7"
                onClick={() =>
                  ctx.setReplyingTo((current) => (current === comment.id ? null : comment.id))
                }
                aria-label={t('auto.components.GitHubItemDialog.bca8eb39ac', 'Reply to comment')}
              >
                <MessageSquarePlus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t('auto.components.GitHubItemDialog.bca8eb39ac', 'Reply to comment')}
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
                    'auto.components.GitHubItemDialog.a154ec5224',
                    'Open comment on GitHub'
                  )}
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t('auto.components.GitHubItemDialog.a154ec5224', 'Open comment on GitHub')}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="min-w-0 px-3 py-2">
        <CommentCodeContext
          comment={comment}
          repoPath={ctx.repoPath}
          repoId={ctx.repoId ?? ''}
          sourceContext={ctx.sourceContext}
          prNumber={ctx.prNumber}
          prRepo={ctx.prRepo}
          files={ctx.files}
          headSha={ctx.headSha}
          baseSha={ctx.baseSha}
          loadPRFileContents={loadPRFileContents}
        />
        <CommentMarkdown
          content={comment.body}
          bodyImageUrls={comment.bodyImageUrls}
          variant="document"
          githubRepo={ctx.markdownGitHubRepo}
          className="min-w-0 max-w-full overflow-hidden break-words text-[13px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
        />
        <CommentReactions reactions={comment.reactions} />
        {ctx.resolvedReplyingTo === comment.id && (
          <CommentReplyForm
            imageUploadAddress={githubCommentImageUploadAddress({
              repoPath: ctx.repoPath ?? '',
              repoId: ctx.repoId,
              sourceContext: ctx.sourceContext,
              type: ctx.itemType,
              prRepo: ctx.prRepo
            })}
            className="mt-3"
            placeholder={
              comment.path
                ? t('auto.components.GitHubItemDialog.86f809e2ce', 'Reply in this review thread')
                : t('auto.components.GitHubItemDialog.080d071d48', 'Reply to @{{value0}}', {
                    value0: comment.author
                  })
            }
            onCancel={() => ctx.setReplyingTo(null)}
            onSubmit={(replyBody) => ctx.handleReply(comment, replyBody)}
          />
        )}
      </div>
    </div>
  )
}

export type ConversationTabCommentCardProps = {
  comment: PRComment
  isReply?: boolean
  repoPath: string | null
  repoId: string
  sourceContext?: TaskSourceContext | null
  itemType: 'issue' | 'pr'
  prNumber: number
  prRepo: GitHubOwnerRepo | null
  files: GitHubPRFile[]
  headSha: string | undefined
  baseSha: string | undefined
  markdownGitHubRepo: GitHubOwnerRepo | null
  resolvedReplyingTo: number | null
  onToggleReply: (commentId: number) => void
  onReply: (comment: PRComment, replyBody: string) => Promise<boolean>
  onCancelReply: () => void
}

export function ConversationTabCommentCard({
  comment,
  isReply = false,
  onToggleReply,
  onReply,
  onCancelReply,
  ...rest
}: ConversationTabCommentCardProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return renderCommentCard(
    comment,
    isReply,
    {
      ...rest,
      handleReply: onReply,
      setReplyingTo: (next) => {
        if (typeof next === 'function') {
          onToggleReply(comment.id)
          return
        }
        if (next === null) {
          onCancelReply()
        }
      }
    },
    t,
    intlLocale
  )
}
