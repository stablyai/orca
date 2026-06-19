import React from 'react'
import { MessageSquare, Plus, SendHorizontal, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  getPrCommentAudienceFilters,
  type PRCommentAudienceFilter
} from '@/lib/pr-comment-audience'
import { translate } from '@/i18n/i18n'

export function PRCommentsListHeader({
  reviewKind,
  commentsCount,
  commentsLoading,
  commentFilter,
  commentCounts,
  canShowResolveWithAI,
  isSelectingForAI,
  selectedCommentQueueCount,
  resolveCommentsWithAIDisabled,
  resolveCommentsWithAIDisabledReason,
  commentsDisabled,
  commentsDisabledReason,
  isAddingComment,
  canAddComment,
  onSendAllSelectable,
  onSendSelected,
  onClearSelection,
  onStartAddComment,
  onFilterChange
}: {
  reviewKind: 'PR' | 'MR'
  commentsCount: number
  commentsLoading: boolean
  commentFilter: PRCommentAudienceFilter
  commentCounts: Record<PRCommentAudienceFilter, number>
  canShowResolveWithAI: boolean
  isSelectingForAI: boolean
  selectedCommentQueueCount: number
  resolveCommentsWithAIDisabled?: boolean
  resolveCommentsWithAIDisabledReason?: string
  commentsDisabled?: boolean
  commentsDisabledReason?: string
  isAddingComment: boolean
  canAddComment: boolean
  onSendAllSelectable: () => void
  onSendSelected: () => void
  onClearSelection: () => void
  onStartAddComment: () => void
  onFilterChange: (filter: PRCommentAudienceFilter) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5 border-b border-border px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <MessageSquare className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium text-foreground">
          {translate('auto.components.right.sidebar.checks.panel.content.94557d68e2', 'Comments')}
        </span>
        {commentsCount > 0 && (
          <span className="text-[10px] text-muted-foreground">{commentsCount}</span>
        )}
        <div className="-mr-1 ml-auto flex items-center gap-0.5">
          {canShowResolveWithAI && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={translate(
                      'auto.components.right.sidebar.checks.panel.content.d7a2f9c401',
                      'Send unresolved {{value0}} comments',
                      { value0: reviewKind }
                    )}
                    disabled={commentsLoading || resolveCommentsWithAIDisabled}
                    title={
                      resolveCommentsWithAIDisabled
                        ? resolveCommentsWithAIDisabledReason
                        : undefined
                    }
                    onClick={onSendAllSelectable}
                  >
                    <Sparkles className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {resolveCommentsWithAIDisabled && resolveCommentsWithAIDisabledReason
                    ? resolveCommentsWithAIDisabledReason
                    : translate(
                        'auto.components.right.sidebar.checks.panel.content.d7a2f9c401',
                        'Send unresolved {{value0}} comments',
                        { value0: reviewKind }
                      )}
                </TooltipContent>
              </Tooltip>
              {isSelectingForAI && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="default"
                        size="icon-xs"
                        className="relative"
                        aria-label={translate(
                          'auto.components.right.sidebar.checks.panel.content.d91f2a6c39',
                          'Send {{value0}} queued comments',
                          { value0: selectedCommentQueueCount }
                        )}
                        disabled={
                          selectedCommentQueueCount === 0 ||
                          commentsLoading ||
                          resolveCommentsWithAIDisabled
                        }
                        title={
                          resolveCommentsWithAIDisabled
                            ? resolveCommentsWithAIDisabledReason
                            : undefined
                        }
                        onClick={onSendSelected}
                      >
                        <SendHorizontal className="size-3" />
                        <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-border bg-background px-0.5 text-[9px] leading-none text-foreground tabular-nums">
                          {selectedCommentQueueCount}
                        </span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      {resolveCommentsWithAIDisabled && resolveCommentsWithAIDisabledReason
                        ? resolveCommentsWithAIDisabledReason
                        : translate(
                            'auto.components.right.sidebar.checks.panel.content.d91f2a6c39',
                            'Send {{value0}} queued comments',
                            { value0: selectedCommentQueueCount }
                          )}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={translate(
                          'auto.components.right.sidebar.checks.panel.content.a6de3e5a20',
                          'Clear queued comments'
                        )}
                        onClick={onClearSelection}
                      >
                        <X className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      {translate(
                        'auto.components.right.sidebar.checks.panel.content.a6de3e5a20',
                        'Clear queued comments'
                      )}
                    </TooltipContent>
                  </Tooltip>
                </>
              )}
            </>
          )}
          {canAddComment && !isAddingComment && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={
                    commentsCount === 0
                      ? translate(
                          'auto.components.right.sidebar.checks.panel.content.7440d09d2c',
                          'Start conversation'
                        )
                      : translate(
                          'auto.components.right.sidebar.checks.panel.content.2b2be92919',
                          'Add comment'
                        )
                  }
                  disabled={commentsDisabled}
                  title={commentsDisabled ? commentsDisabledReason : undefined}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={onStartAddComment}
                >
                  <Plus className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {commentsDisabled && commentsDisabledReason
                  ? commentsDisabledReason
                  : commentsCount === 0
                    ? translate(
                        'auto.components.right.sidebar.checks.panel.content.7440d09d2c',
                        'Start conversation'
                      )
                    : translate(
                        'auto.components.right.sidebar.checks.panel.content.2b2be92919',
                        'Add comment'
                      )}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      {commentsCount > 0 && (
        <div className="grid grid-cols-3 rounded-md border border-border bg-background p-0.5">
          {getPrCommentAudienceFilters().map((filter) => {
            const isActive = commentFilter === filter.value
            return (
              <button
                key={filter.value}
                type="button"
                className={cn(
                  'flex h-7 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors',
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
      {commentsCount >= 100 && (
        <div className="mt-1.5 text-[10px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.checks.panel.content.751f7c6e5c',
            'Showing first 100 comments per source'
          )}
        </div>
      )}
    </div>
  )
}
