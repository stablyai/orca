import React from 'react'
import { Bell, CircleCheck, GitBranch } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getWorktreeStatusLabel, type WorktreeStatus } from '@/lib/worktree-status'
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
  hasBranchIdentity?: boolean
  branchIdentityLabel?: string
  className?: string
}

// Why: a missing review display can also mean provider state is unavailable,
// so the passive label names the identity cue without claiming no review exists.
function getDefaultBranchIdentityLabel(): string {
  return translate('auto.components.sidebar.WorktreeCardStatusSlot.branchIdentity', 'Branch')
}
// Why: two compact cells preserve the existing 20px status lane while keeping
// activity and review/branch identity independently visible.
const compactReviewAndBranchStatusIconClassName = 'size-2.5'
const branchStatusIconClassName = `${compactReviewAndBranchStatusIconClassName} text-muted-foreground/70`
// Why: the corner badge keeps unread distinct without taking either status
// cell or widening the lane; ring-sidebar cuts it out from the nearby glyph.
const newCardUnreadAlertClassName =
  'pointer-events-none absolute -right-0.5 -top-0.5 size-[6px] rounded-full bg-amber-500 ring-2 ring-sidebar'

function NewCardActivityIcon({ status }: { status: WorktreeStatus }): React.JSX.Element {
  if (status === 'done') {
    // Why: the new card shows activity beside review state, so completion needs
    // a distinct shape instead of sharing active's emerald dot.
    return (
      <span
        data-worktree-activity-status={status}
        className="inline-flex size-2.5 items-center justify-center"
        aria-hidden="true"
      >
        <CircleCheck className="size-2.5 text-emerald-500" />
      </span>
    )
  }

  return (
    <span
      data-worktree-activity-status={status}
      className="inline-flex size-2.5 items-center justify-center"
      aria-hidden="true"
    >
      {/* Why: the outer tooltip names every lane signal; an inner native title
          would compete with that complete description. */}
      <StatusIndicator status={status} className="size-2.5" title="" />
    </span>
  )
}

function getReviewStatusTooltip(review: WorktreeCardPrDisplay): string {
  const label = getReviewLabel(review)
  if (review.state === 'merged') {
    return `${label}: Merged`
  }
  if (review.state === 'closed') {
    return `${label}: Closed`
  }
  if (review.state === 'draft') {
    return `${label}: Draft`
  }
  if (review.status === 'failure') {
    return `${label} checks: Failed`
  }
  if (review.status === 'pending') {
    return `${label} checks: Pending`
  }
  if (review.status === 'success') {
    return `${label} checks: Passing`
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
  hasBranchIdentity = false,
  branchIdentityLabel,
  className
}: WorktreeCardStatusSlotProps): React.JSX.Element | null {
  const status = useWorktreeActivityStatus(worktreeId)
  const statusLabel = getWorktreeStatusLabel(status) || status
  const canShowReviewStatus = newCardStyle && showStatus && prDisplay !== null
  const canShowBranchStatus = newCardStyle && showStatus && hasBranchIdentity && prDisplay === null
  const identityStatusLabel =
    canShowReviewStatus && prDisplay
      ? getReviewStatusTooltip(prDisplay)
      : canShowBranchStatus
        ? (branchIdentityLabel ?? getDefaultBranchIdentityLabel())
        : null
  const passiveStatusLabel = identityStatusLabel
    ? `${statusLabel} · ${identityStatusLabel}`
    : statusLabel
  const passiveStatusTooltip =
    newCardStyle && isUnread ? `${passiveStatusLabel} · Unread` : passiveStatusLabel
  const showNewCardUnreadAlert = newCardStyle && isUnread && showStatus
  const reviewStatusIconClassName = compactReviewAndBranchStatusIconClassName
  const branchStatusIcon = <GitBranch className={branchStatusIconClassName} aria-hidden="true" />
  const passiveStatus =
    newCardStyle && showStatus ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-worktree-status-lane=""
            data-worktree-status-lane-unread={showNewCardUnreadAlert ? '' : undefined}
            className={cn(
              'relative inline-grid size-5 shrink-0 items-center justify-items-center',
              canShowReviewStatus || canShowBranchStatus ? 'grid-cols-2' : 'grid-cols-1',
              className
            )}
          >
            <NewCardActivityIcon status={status} />
            {canShowReviewStatus && prDisplay ? (
              <span
                data-worktree-review-status=""
                className="inline-flex size-2.5 items-center justify-center"
                aria-hidden="true"
              >
                <ReviewIcon
                  review={prDisplay}
                  className={reviewStatusIconClassName}
                  variant="generic"
                />
              </span>
            ) : canShowBranchStatus ? (
              <span
                data-worktree-branch-status=""
                className="inline-flex size-2.5 items-center justify-center"
                aria-hidden="true"
              >
                {branchStatusIcon}
              </span>
            ) : null}
            {showNewCardUnreadAlert ? (
              <span
                data-worktree-unread-alert=""
                className={newCardUnreadAlertClassName}
                aria-hidden="true"
              />
            ) : null}
            <span className="sr-only">{passiveStatusTooltip}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          <span>{passiveStatusTooltip}</span>
        </TooltipContent>
      </Tooltip>
    ) : (
      <>
        <StatusIndicator status={status} aria-hidden="true" className={className} />
        <span className="sr-only">{statusLabel}</span>
      </>
    )

  const unreadActionEnabled = showUnreadAction && !newCardStyle

  if (!showStatus && !unreadActionEnabled) {
    return null
  }

  if (!unreadActionEnabled) {
    return passiveStatus
  }

  const actionLabel = isUnread ? 'Mark as read' : 'Mark as unread'
  const tooltip =
    showStatus && !isUnread ? `${passiveStatusLabel} · ${unreadTooltip}` : unreadTooltip

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
              newCardStyle && showStatus ? 'size-5' : 'size-4',
              'hover:bg-accent/80 active:scale-95',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              className
            )}
            aria-label={actionLabel}
          >
            {newCardStyle ? (
              showStatus && canShowReviewStatus && prDisplay ? (
                <span className="inline-flex size-5 items-center justify-center p-0.5">
                  <ReviewIcon
                    review={prDisplay}
                    className={reviewStatusIconClassName}
                    variant="generic"
                  />
                </span>
              ) : showStatus && canShowBranchStatus ? (
                <span className="inline-flex size-5 items-center justify-center p-0.5">
                  {branchStatusIcon}
                </span>
              ) : showStatus ? (
                <StatusIndicator status={status} aria-hidden="true" />
              ) : (
                <span className="sr-only">{actionLabel}</span>
              )
            ) : isUnread ? (
              <FilledBellIcon className="size-[13px] text-amber-500 drop-shadow-sm" />
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
