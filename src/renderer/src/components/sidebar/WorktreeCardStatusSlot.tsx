import React from 'react'
import { Bell } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getWorktreeStatusLabel } from '@/lib/worktree-status'
import { FilledBellIcon } from './WorktreeCardHelpers'
import StatusIndicator from './StatusIndicator'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { getReviewLabel, ReviewIcon } from './worktree-review-helpers'

type WorktreeCardStatusSlotProps = {
  worktreeId: string
  showStatus: boolean
  showUnreadAction: boolean
  isUnread: boolean
  unreadTooltip: string
  onToggleUnread: React.MouseEventHandler<HTMLButtonElement>
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>
  prDisplay?: WorktreeCardPrDisplay | null
  newCardStyle?: boolean
  className?: string
}

function getReviewStatusTooltip(review: WorktreeCardPrDisplay): string {
  const label = getReviewLabel(review)
  if (review.status === 'failure') {
    return `${label} checks: Failed`
  }
  if (review.status === 'pending') {
    return `${label} checks: Pending`
  }
  if (review.status === 'success') {
    return `${label} checks: Passing`
  }
  if (review.state === 'merged') {
    return `${label}: Merged`
  }
  if (review.state === 'closed') {
    return `${label}: Closed`
  }
  if (review.state === 'draft') {
    return `${label}: Draft`
  }
  return `${label}: Open`
}

export function WorktreeCardStatusSlot({
  worktreeId,
  showStatus,
  showUnreadAction,
  isUnread,
  unreadTooltip,
  onToggleUnread,
  onPointerDown,
  prDisplay = null,
  newCardStyle = false,
  className
}: WorktreeCardStatusSlotProps): React.JSX.Element | null {
  const status = useWorktreeActivityStatus(worktreeId)
  const statusLabel = getWorktreeStatusLabel(status) || status
  const canShowReviewStatus =
    newCardStyle && showStatus && prDisplay !== null && (status === 'active' || status === 'done')
  const passiveStatusLabel =
    canShowReviewStatus && prDisplay ? getReviewStatusTooltip(prDisplay) : statusLabel
  // Why: the PR/MR glyph has more visual weight below its center than the dot
  // status indicator, so its status-lane instance needs a tiny optical lift.
  const reviewStatusIconClassName = 'size-4 -translate-y-px'
  const passiveStatus =
    canShowReviewStatus && prDisplay ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn('inline-flex size-5 items-center justify-center p-0.5', className)}>
            <ReviewIcon review={prDisplay} className={reviewStatusIconClassName} />
            <span className="sr-only">{passiveStatusLabel}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          <span>{passiveStatusLabel}</span>
        </TooltipContent>
      </Tooltip>
    ) : (
      <>
        <StatusIndicator status={status} aria-hidden="true" className={className} />
        <span className="sr-only">{statusLabel}</span>
      </>
    )

  if (!showStatus && !showUnreadAction) {
    return null
  }

  if (!showUnreadAction) {
    return passiveStatus
  }

  const actionLabel = isUnread ? 'Mark as read' : 'Mark as unread'
  const tooltip =
    showStatus && (!isUnread || (newCardStyle && canShowReviewStatus && prDisplay))
      ? `${passiveStatusLabel} · ${unreadTooltip}`
      : unreadTooltip

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-workspace-board-preserve-open=""
            onPointerDown={onPointerDown}
            onClick={onToggleUnread}
            className={cn(
              'group/unread relative flex cursor-pointer items-center justify-center rounded transition-all',
              canShowReviewStatus && prDisplay ? 'size-5' : 'size-4',
              'hover:bg-accent/80 active:scale-95',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              className
            )}
            aria-label={actionLabel}
          >
            {isUnread && showStatus && canShowReviewStatus && prDisplay ? (
              <>
                <span className="inline-flex size-5 items-center justify-center p-0.5">
                  <ReviewIcon review={prDisplay} className={reviewStatusIconClassName} />
                </span>
                <FilledBellIcon className="absolute -right-1 -top-1 size-[13px] text-amber-500 drop-shadow-sm" />
              </>
            ) : isUnread ? (
              <FilledBellIcon className="size-[13px] text-amber-500 drop-shadow-sm" />
            ) : showStatus && canShowReviewStatus && prDisplay ? (
              <>
                <span className="inline-flex size-5 items-center justify-center p-0.5 transition-opacity group-hover/unread:opacity-0 group-focus-within/unread:opacity-0">
                  <ReviewIcon review={prDisplay} className={reviewStatusIconClassName} />
                </span>
                <Bell className="absolute size-3 text-muted-foreground/40 opacity-0 transition-opacity group-hover/unread:opacity-100 group-focus-within/unread:opacity-100" />
              </>
            ) : showStatus ? (
              <>
                <StatusIndicator
                  status={status}
                  aria-hidden="true"
                  className="transition-opacity group-hover/unread:opacity-0 group-focus-within/unread:opacity-0"
                />
                <Bell className="absolute size-3 text-muted-foreground/40 opacity-0 transition-opacity group-hover/unread:opacity-100 group-focus-within/unread:opacity-100" />
              </>
            ) : (
              <Bell className="size-3 text-muted-foreground/40 can-hover:opacity-0 transition-opacity group-hover:opacity-100 group-hover/unread:opacity-100 group-focus-within/unread:opacity-100" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          <span>{tooltip}</span>
        </TooltipContent>
      </Tooltip>
      {showStatus && <span className="sr-only">{statusLabel}</span>}
    </>
  )
}
