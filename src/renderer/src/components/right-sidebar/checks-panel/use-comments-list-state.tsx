import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import {
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  type PRCommentAudienceFilter
} from '../../../../../shared/pr-comment-audience'
import {
  getPRCommentGroupId,
  groupPRComments,
  type PRCommentGroup
} from '../../../../../shared/pr-comment-groups'
import {
  getPRCommentGroupActionState,
  isPRCommentGroupQueueableForAI,
  partitionPRCommentGroupsForTriage,
  sortPRCommentGroupsByRecency
} from '@/lib/pr-comment-action-state'
import { getPRCommentPresentationClasses } from '../pr-comment-presentation'
import type { GitHubReactionContent, PRComment } from '../../../../../shared/github/comment-types'
import {
  RightPanelCommentComposer,
  type RightPanelCommentSubmitResult
} from '../right-panel-comment-composer'
import {
  usePRCommentsListSelection,
  type PRCommentsListSelectionClearRequest
} from '../pr-comments-list-selection'
import { usePRBotAuthorOverrides } from '@/lib/pr-bot-author-overrides'
import { translate } from '@/i18n/i18n'
import { PRCommentGroupView } from './comment-group'
import { useNow } from '@/hooks/use-now'

export type PRCommentsListDisplayMode = 'triage' | 'timeline'
export const PR_COMMENT_LIST_DISPLAY_MODES: PRCommentsListDisplayMode[] = ['triage', 'timeline']
export function getPRCommentsListDisplayModeLabel(mode: PRCommentsListDisplayMode): string {
  return mode === 'triage'
    ? translate('auto.components.right.sidebar.checks.panel.content.8a621a2c4f', 'Grouped')
    : translate('auto.components.right.sidebar.checks.panel.content.b13f85d75c', 'Timeline')
}

export type PRCommentsListProps = {
  comments: PRComment[]
  commentsLoading: boolean
  reviewKind?: 'PR' | 'MR'
  commentsDisabled?: boolean
  commentsDisabledReason?: string
  selectionContextKey?: string
  selectionClearRequest?: PRCommentsListSelectionClearRequest | null
  resolveCommentsWithAIDisabled?: boolean
  resolveCommentsWithAIDisabledReason?: string
  onAddComment?: (body: string) => Promise<RightPanelCommentSubmitResult>
  onResolveSelectedCommentsWithAI?: (groups: PRCommentGroup[]) => void
  onReply?: (comment: PRComment, body: string) => Promise<RightPanelCommentSubmitResult>
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
  onEditComment?: (comment: PRComment, body: string) => Promise<boolean>
  onDeleteComment?: (comment: PRComment) => void | Promise<void>
  onSetReaction?: (
    comment: PRComment,
    content: GitHubReactionContent,
    reacted: boolean
  ) => Promise<boolean>
}

export function useCommentsListState({
  comments,
  commentsDisabled,
  commentsDisabledReason,
  selectionContextKey,
  selectionClearRequest,
  onAddComment,
  onReply,
  onResolve,
  onEditComment,
  onDeleteComment,
  onSetReaction,
  onResolveSelectedCommentsWithAI
}: PRCommentsListProps) {
  function findVerticalScrollParent(element: HTMLElement): HTMLElement | null {
    let parent = element.parentElement
    while (parent) {
      const style = window.getComputedStyle(parent)
      const canScroll = style.overflowY === 'auto' || style.overflowY === 'scroll'
      if (canScroll && parent.scrollHeight > parent.clientHeight) {
        return parent
      }
      parent = parent.parentElement
    }
    return null
  }

  function scrollElementBottomIntoView(element: HTMLElement): void {
    const scrollParent = findVerticalScrollParent(element)
    if (!scrollParent) {
      element.scrollIntoView({ block: 'end', behavior: 'smooth' })
      return
    }

    const padding = 8
    const parentRect = scrollParent.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    const bottomOverflow = elementRect.bottom - parentRect.bottom + padding
    if (bottomOverflow > 0) {
      scrollParent.scrollTo({
        top: scrollParent.scrollTop + bottomOverflow,
        behavior: 'smooth'
      })
      return
    }

    const topOverflow = elementRect.top - parentRect.top - padding
    if (topOverflow < 0) {
      scrollParent.scrollTo({
        top: Math.max(0, scrollParent.scrollTop + topOverflow),
        behavior: 'smooth'
      })
    }
  }

  const presentation = React.useMemo(() => getPRCommentPresentationClasses(), [])
  const now = useNow(60_000, comments.length > 0)
  const [commentFilter, setCommentFilter] = useState<PRCommentAudienceFilter>('all')
  const [displayMode, setDisplayMode] = useState<PRCommentsListDisplayMode>('triage')
  const [replyingCommentId, setReplyingCommentId] = useState<number | null>(null)
  const [isAddingComment, setIsAddingComment] = useState(false)
  const addCommentSurfaceRef = useRef<HTMLDivElement>(null)
  const shouldScrollAddCommentRef = useRef(false)
  const botAuthorOverrides = usePRBotAuthorOverrides()
  const commentCounts = React.useMemo(
    () => getPRCommentAudienceCounts(comments, botAuthorOverrides),
    [botAuthorOverrides, comments]
  )
  const {
    isSelectingForAI,
    selectedGroupIds,
    selectableGroups,
    selectableGroupsById,
    selectedGroups,
    addGroupToSelection,
    clearSelection,
    toggleGroupSelection
  } = usePRCommentsListSelection(comments, selectionContextKey, selectionClearRequest)
  const visibleComments = React.useMemo(
    () => filterPRCommentsByAudience(comments, commentFilter, botAuthorOverrides),
    [botAuthorOverrides, commentFilter, comments]
  )
  const groups = React.useMemo(() => groupPRComments(visibleComments), [visibleComments])
  const triageGroups = React.useMemo(
    // Why: grouped sections read newest-first so recent discussion surfaces at the top.
    () => partitionPRCommentGroupsForTriage(sortPRCommentGroupsByRecency(groups, 'newest-first')),
    [groups]
  )
  // Why: timeline reads oldest-first so the discussion history unfolds in order.
  const timelineGroups = React.useMemo(() => sortPRCommentGroupsByRecency(groups), [groups])
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
        className="shrink-0"
      />
    )
  }

  const renderCommentGroup = (group: PRCommentGroup): React.JSX.Element => {
    const groupId = getPRCommentGroupId(group)
    const actionState = getPRCommentGroupActionState(group)
    const isQueued = selectedGroupIds.has(groupId)
    const canQueue =
      canShowResolveWithAI &&
      !isQueued &&
      isPRCommentGroupQueueableForAI(group) &&
      selectableGroupsById.has(groupId) &&
      !isSelectingForAI
    return (
      <PRCommentGroupView
        key={groupId}
        group={group}
        botAuthorOverrides={botAuthorOverrides}
        replyingCommentId={replyingCommentId}
        selectionControl={renderSelectionControl(group)}
        actionState={actionState}
        isQueued={isQueued}
        now={now}
        replyDisabled={commentsDisabled}
        replyDisabledReason={commentsDisabledReason}
        presentation={presentation}
        onResolve={onResolve}
        onStartReply={setReplyingCommentId}
        onCancelReply={(commentId) =>
          setReplyingCommentId((current) => (current === commentId ? null : current))
        }
        onReply={onReply}
        onEditComment={onEditComment}
        onDeleteComment={onDeleteComment}
        onSetReaction={onSetReaction}
        onQueueForAgent={canQueue ? () => addGroupToSelection(groupId) : undefined}
      />
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

  return {
    presentation,
    commentFilter,
    setCommentFilter,
    displayMode,
    setDisplayMode,
    replyingCommentId,
    setReplyingCommentId,
    isAddingComment,
    botAuthorOverrides,
    commentCounts,
    isSelectingForAI,
    selectableGroups,
    selectedGroups,
    selectedCommentQueueCount,
    clearSelection,
    visibleComments,
    triageGroups,
    timelineGroups,
    canShowResolveWithAI,
    startAddComment,
    renderCommentGroup,
    renderAddCommentComposer,
    now
  }
}
