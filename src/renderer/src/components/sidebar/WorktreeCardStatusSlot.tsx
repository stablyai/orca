import React from 'react'
import { Bell, GitBranch } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getWorktreeStatusLabel, type WorktreeStatus } from '@/lib/worktree-status'
import { FilledBellIcon } from './WorktreeCardHelpers'
import StatusIndicator from './StatusIndicator'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { getReviewLabel, ReviewIcon } from './worktree-review-helpers'
import { WorktreeCardDetailSection } from './WorktreeCardDetailSection'
import { DetailHeader } from './WorktreeCardMetadataControls'

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
  statusTooltipEnabled?: boolean
  className?: string
}

// Why: interrupted is a destructive outcome, so review or branch identity must
// not replace it even though Smart attention correctly treats it as quiet.
const QUIET_REVIEW_REPLACEABLE_STATUSES = new Set<WorktreeStatus>(['active', 'done', 'inactive'])
// Why: a missing review display can also mean provider state is unavailable,
// so the passive label names the identity cue without claiming no review exists.
function getDefaultBranchIdentityLabel(): string {
  return translate('auto.components.sidebar.WorktreeCardStatusSlot.branchIdentity', 'Branch')
}
// Why: branch-style SVGs are optically left-heavy; this keeps them aligned with
// the centered activity dots in the shared status column.
const compactReviewAndBranchStatusIconClassName = 'size-[13px] translate-x-px'
const branchStatusIconClassName = `${compactReviewAndBranchStatusIconClassName} text-muted-foreground/70`
// Why: a left-edge badge overlays unread on the status glyph without widening
// the lane or indenting the title; ring-worktree-sidebar cuts it out from busy icons.
const newCardUnreadAlertClassName =
  'pointer-events-none absolute left-0 top-1/2 size-[6px] -translate-y-1/2 rounded-full bg-status-attention ring-2 ring-worktree-sidebar'

function renderPassiveStatusTooltip(
  trigger: React.JSX.Element,
  label: string,
  enabled: boolean
): React.JSX.Element {
  if (!enabled) {
    return trigger
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span>{label}</span>
      </TooltipContent>
    </Tooltip>
  )
}

function overlayNewCardUnreadStatus(
  status: React.JSX.Element,
  showUnreadAlert: boolean
): React.JSX.Element {
  if (!showUnreadAlert) {
    return status
  }

  return (
    <span
      data-worktree-status-lane-unread=""
      className="relative inline-flex size-5 shrink-0 items-center justify-center"
    >
      {status}
      <span
        data-worktree-unread-alert=""
        className={newCardUnreadAlertClassName}
        aria-hidden="true"
      />
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

function getActivityStatusLabel(status: WorktreeStatus): string {
  // Why: canonical worktree state labels are currently English; keep the
  // prefix in that same language instead of producing partially localized copy.
  return `Activity: ${getWorktreeStatusLabel(status)}`
}

export function WorktreeCardHoverActivityStatus({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element {
  const status = useWorktreeActivityStatus(worktreeId)
  return (
    <WorktreeCardDetailSection data-worktree-hover-activity-status={status}>
      <DetailHeader
        icon={
          <StatusIndicator
            status={status}
            showTooltip={false}
            aria-hidden="true"
            className="size-3"
          />
        }
        label={getActivityStatusLabel(status)}
      />
    </WorktreeCardDetailSection>
  )
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
  statusTooltipEnabled = true,
  className
}: WorktreeCardStatusSlotProps): React.JSX.Element | null {
  const status = useWorktreeActivityStatus(worktreeId)
  const statusLabel = getWorktreeStatusLabel(status) || status
  const canShowReviewStatus =
    newCardStyle &&
    showStatus &&
    prDisplay !== null &&
    QUIET_REVIEW_REPLACEABLE_STATUSES.has(status)
  const canShowBranchStatus =
    newCardStyle &&
    showStatus &&
    hasBranchIdentity &&
    prDisplay === null &&
    QUIET_REVIEW_REPLACEABLE_STATUSES.has(status)
  const passiveStatusLabel =
    canShowReviewStatus && prDisplay
      ? getReviewStatusTooltip(prDisplay)
      : canShowBranchStatus
        ? (branchIdentityLabel ?? getDefaultBranchIdentityLabel())
        : statusLabel
  const passiveStatusTooltip =
    newCardStyle && isUnread ? `${passiveStatusLabel} · Unread` : passiveStatusLabel
  // Why: live working, permission, and blocked states own the status lane, but
  // unread state should still surface in tooltip/sr-only copy and reappear afterward.
  const showNewCardUnreadAlert =
    newCardStyle &&
    isUnread &&
    showStatus &&
    status !== 'working' &&
    status !== 'permission' &&
    status !== 'blocked'
  const reviewStatusIconClassName = compactReviewAndBranchStatusIconClassName
  const branchStatusIcon = <GitBranch className={branchStatusIconClassName} aria-hidden="true" />
  const passiveStatus =
    canShowReviewStatus && prDisplay ? (
      renderPassiveStatusTooltip(
        <span className={cn('inline-flex size-5 items-center justify-center p-0.5', className)}>
          <ReviewIcon review={prDisplay} className={reviewStatusIconClassName} variant="generic" />
          <span className="sr-only">{passiveStatusTooltip}</span>
        </span>,
        passiveStatusTooltip,
        statusTooltipEnabled
      )
    ) : canShowBranchStatus ? (
      renderPassiveStatusTooltip(
        <span className={cn('inline-flex size-5 items-center justify-center p-0.5', className)}>
          {branchStatusIcon}
          <span className="sr-only">{passiveStatusTooltip}</span>
        </span>,
        passiveStatusTooltip,
        statusTooltipEnabled
      )
    ) : newCardStyle && showStatus ? (
      <>
        <StatusIndicator
          status={status}
          aria-hidden="true"
          className={cn('size-5', className)}
          tooltipSide="right"
          tooltipSideOffset={8}
          tooltipLabel={passiveStatusTooltip}
          showTooltip={statusTooltipEnabled}
        />
        <span className="sr-only">{passiveStatusTooltip}</span>
      </>
    ) : (
      <>
        <StatusIndicator
          status={status}
          aria-hidden="true"
          className={className}
          tooltipSide="right"
          tooltipSideOffset={8}
          showTooltip={statusTooltipEnabled}
        />
        <span className="sr-only">{statusLabel}</span>
      </>
    )

  const unreadActionEnabled = showUnreadAction && !newCardStyle

  if (!showStatus && !unreadActionEnabled) {
    return null
  }

  if (!unreadActionEnabled) {
    return overlayNewCardUnreadStatus(passiveStatus, showNewCardUnreadAlert)
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
                <StatusIndicator status={status} aria-hidden="true" showTooltip={false} />
              ) : (
                <span className="sr-only">{actionLabel}</span>
              )
            ) : isUnread ? (
              <FilledBellIcon className="size-[13px] text-status-attention drop-shadow-sm" />
            ) : showStatus ? (
              <>
                <StatusIndicator
                  status={status}
                  aria-hidden="true"
                  showTooltip={false}
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
