import React from 'react'
import { FolderKanban, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  getPRCommentAudienceEmptyLabel,
  getPrCommentAudienceFilters
} from '@/lib/pr-comment-audience-labels'
import type { PRCommentAudienceFilter } from '../../../../../shared/pr-comment-audience'
import type { PRCommentGroup } from '../../../../../shared/pr-comment-groups'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { GitHubOwnerRepo, GitHubPRFile } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import type { IssueConversationEntry } from './issue-conversation-entries'
import { ConversationTabCommentCard } from './conversation-tab-comment-card'
import { ConversationTabCommentGroup } from './conversation-tab-comment-group'
import { ConversationTabTimelineActivity } from './conversation-tab-timeline'

export function ConversationTabActivity({
  item,
  comments,
  commentFilter,
  commentCounts,
  visibleComments,
  visibleCommentGroups,
  resolvedTimelineItemsLength,
  issueConversationEntries,
  commentCardProps,
  onCommentFilterChange
}: {
  item: GitHubWorkItem
  comments: PRComment[]
  commentFilter: PRCommentAudienceFilter
  commentCounts: Record<PRCommentAudienceFilter, number>
  visibleComments: PRComment[]
  visibleCommentGroups: PRCommentGroup[]
  resolvedTimelineItemsLength: number
  issueConversationEntries: IssueConversationEntry[]
  commentCardProps: {
    repoPath: string | null
    repoId: string
    sourceContext?: TaskSourceContext | null
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
  onCommentFilterChange: (filter: PRCommentAudienceFilter) => void
}): React.JSX.Element {
  return (
    <>
      <div className="flex items-center gap-2 pt-1">
        {item.type === 'issue' ? (
          <FolderKanban className="size-4 text-muted-foreground" />
        ) : (
          <MessageSquare className="size-4 text-muted-foreground" />
        )}
        <span className="text-[13px] font-medium text-foreground">
          {item.type === 'issue'
            ? translate('auto.components.GitHubItemDialog.timeline.activity', 'Activity')
            : translate('auto.components.GitHubItemDialog.1506916c09', 'Comments')}
        </span>
        {comments.length + (item.type === 'issue' ? resolvedTimelineItemsLength : 0) > 0 && (
          <span className="rounded-full border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            {comments.length + (item.type === 'issue' ? resolvedTimelineItemsLength : 0)}
          </span>
        )}
      </div>

      {item.type === 'pr' && comments.length > 0 && (
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
                onClick={() => onCommentFilterChange(filter.value)}
              >
                <span>{filter.label}</span>
                <span className="tabular-nums">{commentCounts[filter.value]}</span>
              </button>
            )
          })}
        </div>
      )}

      {item.type === 'issue' ? (
        issueConversationEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/50 px-3 py-6 text-left text-[13px] text-muted-foreground">
            {translate('auto.components.GitHubItemDialog.timeline.noActivity', 'No activity yet.')}
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            {issueConversationEntries.map((entry) =>
              entry.kind === 'comment' ? (
                <ConversationTabCommentCard
                  key={entry.id}
                  comment={entry.comment}
                  {...commentCardProps}
                />
              ) : (
                <ConversationTabTimelineActivity key={entry.id} activity={entry.activity} />
              )
            )}
          </div>
        )
      ) : comments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 px-3 py-6 text-left text-[13px] text-muted-foreground">
          {translate('auto.components.GitHubItemDialog.5a94f3d0e9', 'No comments yet.')}
        </div>
      ) : visibleComments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 px-3 py-6 text-center text-[13px] text-muted-foreground">
          {getPRCommentAudienceEmptyLabel(commentFilter)}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          {visibleCommentGroups.map((group) => (
            <ConversationTabCommentGroup
              key={group.kind === 'thread' ? group.root.id : group.comment.id}
              group={group}
              {...commentCardProps}
            />
          ))}
        </div>
      )}
    </>
  )
}
