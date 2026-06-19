import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Sparkles } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  getPRCommentAudienceEmptyLabel,
  type PRCommentAudienceFilter
} from '@/lib/pr-comment-audience'
import {
  getPRCommentGroupId,
  groupPRComments,
  isResolvedPRCommentGroup,
  type PRCommentGroup
} from '@/lib/pr-comment-groups'
import { translate } from '@/i18n/i18n'
import {
  RightPanelCommentComposer,
  type RightPanelCommentSubmitResult
} from './right-panel-comment-composer'
import { usePRCommentsListSelection } from './pr-comments-list-selection'
import { PRCommentsListHeader } from './pr-comments-list-header'
import { PRCommentGroupView, ResolvedCommentGroupAccordion } from './pr-comment-group-view'
import { scrollElementBottomIntoView } from './pr-comments-list-scroll'
import type { PRComment } from '../../../../shared/types'

/** Renders the PR comments section below checks. */
export function PRCommentsList({
  comments,
  commentsLoading,
  reviewKind = 'PR',
  commentsDisabled,
  commentsDisabledReason,
  selectionContextKey,
  resolveCommentsWithAIDisabled,
  resolveCommentsWithAIDisabledReason,
  onAddComment,
  onResolveSelectedCommentsWithAI,
  onReply,
  onResolve,
  onEditComment,
  onDeleteComment
}: {
  comments: PRComment[]
  commentsLoading: boolean
  reviewKind?: 'PR' | 'MR'
  commentsDisabled?: boolean
  commentsDisabledReason?: string
  selectionContextKey?: string
  resolveCommentsWithAIDisabled?: boolean
  resolveCommentsWithAIDisabledReason?: string
  onAddComment?: (body: string) => Promise<RightPanelCommentSubmitResult>
  onResolveSelectedCommentsWithAI?: (groups: PRCommentGroup[]) => void
  onReply?: (comment: PRComment, body: string) => Promise<RightPanelCommentSubmitResult>
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
  onEditComment?: (comment: PRComment, body: string) => Promise<boolean>
  onDeleteComment?: (comment: PRComment) => void | Promise<void>
}): React.JSX.Element {
  const [commentFilter, setCommentFilter] = useState<PRCommentAudienceFilter>('all')
  const [replyingGroupId, setReplyingGroupId] = useState<string | null>(null)
  const [isAddingComment, setIsAddingComment] = useState(false)
  const addCommentSurfaceRef = useRef<HTMLDivElement>(null)
  const shouldScrollAddCommentRef = useRef(false)
  const commentCounts = useMemo(() => getPRCommentAudienceCounts(comments), [comments])
  const {
    isSelectingForAI,
    selectedGroupIds,
    selectableGroups,
    selectableGroupsById,
    selectedGroups,
    addGroupToSelection,
    clearSelection,
    toggleGroupSelection
  } = usePRCommentsListSelection(comments, selectionContextKey)
  const visibleComments = useMemo(
    () => filterPRCommentsByAudience(comments, commentFilter),
    [commentFilter, comments]
  )
  const groups = useMemo(() => groupPRComments(visibleComments), [visibleComments])
  const canShowResolveWithAI = Boolean(
    onResolveSelectedCommentsWithAI && selectableGroups.length > 0
  )
  const selectedCommentQueueCount = selectedGroups.length

  useEffect(() => {
    if (!isAddingComment || !shouldScrollAddCommentRef.current) {
      return
    }
    shouldScrollAddCommentRef.current = false
    let secondFrame: number | null = null
    const scrollComposerIntoView = (): void => {
      const surface = addCommentSurfaceRef.current
      if (surface) {
        scrollElementBottomIntoView(surface)
      }
    }
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(scrollComposerIntoView)
    })
    // Why: the composer expands and focuses in separate layout passes; the
    // timeout catches the final height so the footer is visible in short panels.
    const settledTimer = window.setTimeout(scrollComposerIntoView, 120)
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame)
      }
      window.clearTimeout(settledTimer)
    }
  }, [isAddingComment])

  const startAddComment = useCallback(() => {
    shouldScrollAddCommentRef.current = true
    setIsAddingComment(true)
  }, [])

  const cancelAddComment = useCallback(() => {
    shouldScrollAddCommentRef.current = false
    setIsAddingComment(false)
  }, [])

  const renderSelectionControl = (group: PRCommentGroup): React.ReactNode => {
    if (!isSelectingForAI || !selectableGroupsById.has(getPRCommentGroupId(group))) {
      return null
    }
    const groupId = getPRCommentGroupId(group)
    const checked = selectedGroupIds.has(groupId)
    return (
      <Checkbox
        aria-label={translate(
          'auto.components.right.sidebar.checks.panel.content.5dc3af25c0',
          'Select comment'
        )}
        checked={checked}
        onCheckedChange={(value) => toggleGroupSelection(groupId, value === true)}
        className="mt-0.5"
      />
    )
  }

  const renderResolveSelectionAction = (group: PRCommentGroup): React.ReactNode => {
    if (isSelectingForAI || !selectableGroupsById.has(getPRCommentGroupId(group))) {
      return null
    }
    const groupId = getPRCommentGroupId(group)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={translate(
              'auto.components.right.sidebar.checks.panel.content.49ea0937e4',
              'Add comment to resolve list'
            )}
            onClick={(event) => {
              event.stopPropagation()
              addGroupToSelection(groupId)
            }}
          >
            <Sparkles className="size-3" />
            {translate('auto.components.right.sidebar.checks.panel.content.9fecebb29d', 'Add')}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {translate(
            'auto.components.right.sidebar.checks.panel.content.49ea0937e4',
            'Add comment to resolve list'
          )}
        </TooltipContent>
      </Tooltip>
    )
  }

  const renderAddCommentComposer = (empty: boolean): React.JSX.Element => (
    <div
      ref={addCommentSurfaceRef}
      className={cn(empty ? 'px-3 py-2' : 'border-t border-border px-3 py-2')}
    >
      <RightPanelCommentComposer
        placeholder={
          empty
            ? translate(
                'auto.components.right.sidebar.checks.panel.content.ea9fd5ed6a',
                'Start conversation...'
              )
            : translate(
                'auto.components.right.sidebar.checks.panel.content.3fff651d32',
                'Add a PR comment'
              )
        }
        submitLabel="Send"
        autoFocus
        disabled={commentsDisabled}
        disabledReason={commentsDisabledReason}
        onCancel={cancelAddComment}
        onSubmit={
          onAddComment ??
          (async () => ({
            ok: false,
            error: translate(
              'auto.components.right.sidebar.checks.panel.content.b37ebdc51c',
              'Commenting unavailable.'
            )
          }))
        }
      />
    </div>
  )

  return (
    <div className="border-t border-border">
      <PRCommentsListHeader
        reviewKind={reviewKind}
        commentsCount={comments.length}
        commentsLoading={commentsLoading}
        commentFilter={commentFilter}
        commentCounts={commentCounts}
        canShowResolveWithAI={canShowResolveWithAI}
        isSelectingForAI={isSelectingForAI}
        selectedCommentQueueCount={selectedCommentQueueCount}
        resolveCommentsWithAIDisabled={resolveCommentsWithAIDisabled}
        resolveCommentsWithAIDisabledReason={resolveCommentsWithAIDisabledReason}
        commentsDisabled={commentsDisabled}
        commentsDisabledReason={commentsDisabledReason}
        isAddingComment={isAddingComment}
        canAddComment={Boolean(onAddComment)}
        onSendAllSelectable={() => onResolveSelectedCommentsWithAI?.(selectableGroups)}
        onSendSelected={() => onResolveSelectedCommentsWithAI?.(selectedGroups)}
        onClearSelection={clearSelection}
        onStartAddComment={startAddComment}
        onFilterChange={setCommentFilter}
      />
      {commentsLoading && comments.length === 0 ? (
        <div className="flex items-center justify-center py-6">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : comments.length === 0 && isAddingComment && onAddComment ? (
        renderAddCommentComposer(true)
      ) : comments.length === 0 ? (
        !onAddComment && (
          <div className="flex items-center justify-center py-5 text-[11px] text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.checks.panel.content.755be805f6',
              'No comments'
            )}
          </div>
        )
      ) : visibleComments.length === 0 ? (
        <div className="flex items-center justify-center py-5 text-[11px] text-muted-foreground">
          {getPRCommentAudienceEmptyLabel(commentFilter)}
        </div>
      ) : (
        <div className="py-1">
          {groups.map((group) =>
            isResolvedPRCommentGroup(group) ? (
              <ResolvedCommentGroupAccordion
                key={getPRCommentGroupId(group)}
                group={group}
                replyingGroupId={replyingGroupId}
                replyDisabled={commentsDisabled}
                replyDisabledReason={commentsDisabledReason}
                onResolve={onResolve}
                onStartReply={setReplyingGroupId}
                onCancelReply={() => setReplyingGroupId(null)}
                onReply={onReply}
                onEditComment={onEditComment}
                onDeleteComment={onDeleteComment}
              />
            ) : (
              <PRCommentGroupView
                key={getPRCommentGroupId(group)}
                group={group}
                replyingGroupId={replyingGroupId}
                selectionControl={renderSelectionControl(group)}
                resolveSelectionAction={renderResolveSelectionAction(group)}
                replyDisabled={commentsDisabled}
                replyDisabledReason={commentsDisabledReason}
                onResolve={onResolve}
                onStartReply={setReplyingGroupId}
                onCancelReply={() => setReplyingGroupId(null)}
                onReply={onReply}
                onEditComment={onEditComment}
                onDeleteComment={onDeleteComment}
              />
            )
          )}
        </div>
      )}
      {onAddComment && comments.length > 0 && isAddingComment && renderAddCommentComposer(false)}
    </div>
  )
}
