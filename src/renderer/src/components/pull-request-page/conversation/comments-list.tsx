import React, { useMemo } from 'react'
import { Check, Copy, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useClipboardTextCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'
import { cn } from '@/lib/utils'
import {
  getPRCommentAudienceEmptyLabel,
  getPrCommentAudienceFilters
} from '@/lib/pr-comment-audience-labels'
import { getPRCommentGroupId, type PRCommentGroup } from '../../../../../shared/pr-comment-groups'
import type { PRCommentAudienceFilter } from '../../../../../shared/pr-comment-audience'
import type { GitHubOwnerRepo, GitHubPRFile } from '../../../../../shared/github/pull-request-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { MentionOption } from '../page-types'
import { translate } from '@/i18n/i18n'
import { ConversationCommentGroup } from './comment-group'
import { buildPRCommentsResolutionPrompt } from '@/components/pr-comments-resolution-prompt'

export function ConversationCommentsList({
  itemType,
  comments,
  visibleComments,
  visibleCommentGroups,
  commentFilter,
  commentCounts,
  repoPath,
  repoId,
  reviewTitle,
  reviewUrl,
  sourceContext,
  prNumber,
  prRepo,
  files,
  headSha,
  baseSha,
  markdownGitHubRepo,
  mentionOptions,
  resolvedReplyingTo,
  onFilterChange,
  onToggleReply,
  onSubmitReply
}: {
  itemType: 'issue' | 'pr'
  comments: PRComment[]
  visibleComments: PRComment[]
  visibleCommentGroups: PRCommentGroup[]
  commentFilter: PRCommentAudienceFilter
  commentCounts: Record<PRCommentAudienceFilter, number>
  repoPath: string | null
  repoId: string
  reviewTitle: string
  reviewUrl: string
  sourceContext?: TaskSourceContext | null
  prNumber: number
  prRepo: GitHubOwnerRepo | null
  files: GitHubPRFile[]
  headSha: string | undefined
  baseSha: string | undefined
  markdownGitHubRepo: { owner: string; repo: string; host?: string } | null
  mentionOptions: MentionOption[]
  resolvedReplyingTo: number | null
  onFilterChange: (value: PRCommentAudienceFilter) => void
  onToggleReply: (commentId: number) => void
  onSubmitReply: (comment: PRComment, replyBody: string) => Promise<boolean>
}): React.JSX.Element {
  const copyText = useMemo(
    () =>
      itemType === 'pr' && visibleCommentGroups.length > 0
        ? buildPRCommentsResolutionPrompt({
            reviewKind: 'PR',
            reviewNumber: prNumber,
            reviewTitle,
            reviewUrl,
            groups: visibleCommentGroups,
            worktreePath: repoPath,
            acknowledgeOnLaunch: false
          })
        : '',
    [itemType, prNumber, repoPath, reviewTitle, reviewUrl, visibleCommentGroups]
  )
  const copyFeedback = useClipboardTextCopyFeedback(copyText)
  const copyLabel =
    copyFeedback.status === 'copied'
      ? translate('auto.components.PullRequestPage.576272291a', 'Copied')
      : copyFeedback.status === 'failed'
        ? translate('auto.components.PullRequestPage.b398ff2f60', "Couldn't copy")
        : copyFeedback.canCopy
          ? translate('auto.components.PullRequestPage.1d737fe9e4', 'Copy all')
          : translate('auto.components.PullRequestPage.9758579efc', 'Nothing to copy')

  return (
    <>
      <div className="flex items-center gap-2 pt-1">
        <MessageSquare className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-medium text-foreground">
          {translate('auto.components.PullRequestPage.3463d10a63', 'Comments')}
        </span>
        {comments.length > 0 && (
          <span className="rounded-full border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            {comments.length}
          </span>
        )}
        {itemType === 'pr' ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="ml-auto min-w-28"
            aria-label={copyLabel}
            disabled={!copyFeedback.canCopy}
            onClick={() => void copyFeedback.copyText()}
          >
            {copyFeedback.status === 'copied' ? <Check /> : <Copy />}
            <span>{copyLabel}</span>
          </Button>
        ) : null}
      </div>

      {itemType === 'pr' && comments.length > 0 && (
        <div className="grid grid-cols-3 rounded-lg border border-border/50 bg-background p-0.5">
          {getPrCommentAudienceFilters().map((filter) => {
            const isActive = commentFilter === filter.value
            return (
              <button
                key={filter.value}
                type="button"
                className={cn(
                  'flex h-8 items-center justify-center gap-1 rounded-md px-2 text-[12px] font-medium text-muted-foreground transition-colors',
                  isActive && 'bg-muted text-foreground'
                )}
                aria-pressed={isActive}
                onClick={() => onFilterChange(filter.value)}
              >
                <span>{filter.label}</span>
                <span className="tabular-nums">{commentCounts[filter.value]}</span>
              </button>
            )
          })}
        </div>
      )}

      {comments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 px-3 py-6 text-left text-[13px] text-muted-foreground">
          {translate('auto.components.PullRequestPage.d2d589556c', 'No comments yet.')}
        </div>
      ) : visibleComments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 px-3 py-6 text-center text-[13px] text-muted-foreground">
          {getPRCommentAudienceEmptyLabel(commentFilter)}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          {visibleCommentGroups.map((group) => (
            <ConversationCommentGroup
              key={getPRCommentGroupId(group)}
              group={group}
              repoPath={repoPath}
              repoId={repoId}
              sourceContext={sourceContext}
              prNumber={prNumber}
              prRepo={prRepo}
              files={files}
              headSha={headSha}
              baseSha={baseSha}
              markdownGitHubRepo={markdownGitHubRepo}
              mentionOptions={mentionOptions}
              resolvedReplyingTo={resolvedReplyingTo}
              onToggleReply={onToggleReply}
              onSubmitReply={onSubmitReply}
            />
          ))}
        </div>
      )}
    </>
  )
}
