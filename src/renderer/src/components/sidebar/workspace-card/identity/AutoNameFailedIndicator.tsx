import React, { useEffect, useRef, useState } from 'react'
import { CircleAlert, LoaderCircle, RotateCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { branchAutoRenameFailureReason } from '../../../../../../shared/worktree/branch-auto-rename-failure-reason'
import { autoNameFailureReasonText } from './auto-name-failure-reason-copy'
import { branchAutoRenameReasonText } from './branch-auto-rename-reason-copy'
import { canDismissAutoName, dismissAutoName } from './branch-auto-rename-actions'
import { useBranchAutoRenameRetry } from './use-branch-auto-rename-retry'
import {
  identityIndicatorHoverHandlers,
  type IdentityBadgeProps
} from './worktree-card-header-items'

const CARD_GAP_PX = 8

/** The row's grey mark for a failed auto-name; its card says why and offers Try again and Dismiss. */
export function AutoNameFailedIndicator({
  card,
  hasHoverDetails,
  worktreeId,
  executionHostId,
  error,
  onPointerDown
}: IdentityBadgeProps & {
  worktreeId: string
  executionHostId: ExecutionHostId | undefined
  /** The persisted error, in any build's wording. */
  error: string
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>
}): React.JSX.Element | null {
  const t = useTranslate()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [sideOffset, setSideOffset] = useState(CARD_GAP_PX)
  const [dismissedError, setDismissedError] = useState<string | null>(null)
  const [dismissing, setDismissing] = useState(false)
  const [canDismiss, setCanDismiss] = useState(false)
  // Follows the row's lifetime, not the card's, so a retry keeps its spinner after the card closes.
  const retry = useBranchAutoRenameRetry({
    open: true,
    worktreeId,
    executionHostId,
    onRenamed: () => setOpen(false),
    onAttemptFinished: () => {}
  })
  useEffect(() => {
    let live = true
    void canDismissAutoName({ worktreeId, executionHostId }).then((value) => {
      if (live) {
        setCanDismiss(value)
      }
    })
    return () => {
      live = false
    }
  }, [worktreeId, executionHostId])

  if (dismissedError === error) {
    return null
  }
  const hover = identityIndicatorHoverHandlers({ card, hasHoverDetails })
  const retrying = retry.running
  const canRetry = retry.availability === 'available'
  const title = retrying
    ? t('auto.components.sidebar.AutoNameFailed.naming', 'Naming this workspace…')
    : t('auto.components.sidebar.AutoNameFailed.title', 'Couldn’t auto-name')
  // A finished retry that didn't fail (e.g. deferred) says so; otherwise the stored error does.
  const outcomeReason = branchAutoRenameReasonText(retry.lastOutcome, t)
  const reason = outcomeReason ?? autoNameFailureReasonText(branchAutoRenameFailureReason(error), t)

  const handleOpenChange = (next: boolean): void => {
    if (next) {
      // Open past the row's edge, where the row's own hover card opens, so no other row is covered.
      const trigger = triggerRef.current
      const row = trigger?.closest('[data-worktree-card-hover-trigger]')
      if (trigger && row) {
        const gap = row.getBoundingClientRect().right - trigger.getBoundingClientRect().right
        setSideOffset(Math.max(0, gap) + CARD_GAP_PX)
      }
    }
    setOpen(next)
  }
  const dismiss = (): void => {
    if (dismissing || retrying) {
      return
    }
    setDismissing(true)
    void dismissAutoName({ worktreeId, executionHostId })
      .then((result) => {
        if (result.dismissed) {
          setDismissedError(error)
          setOpen(false)
        }
      })
      .catch(() => {})
      .finally(() => setDismissing(false))
  }

  return (
    <HoverCard open={open} onOpenChange={handleOpenChange} openDelay={150} closeDelay={150}>
      <HoverCardTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={title}
          data-worktree-card-identity-indicator=""
          onPointerDown={onPointerDown}
          onPointerEnter={hover.onPointerEnter}
          onPointerLeave={hover.onPointerLeave}
          onFocus={hover.onFocus}
          onClick={(event) => {
            event.stopPropagation()
            handleOpenChange(true)
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          {retrying ? (
            <LoaderCircle className="size-3 animate-spin" aria-hidden />
          ) : (
            <CircleAlert className="size-3" aria-hidden />
          )}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="center"
        sideOffset={sideOffset}
        variant="workspace-details"
        className="w-auto max-w-[min(26rem,calc(100vw-2rem))]"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        // Portaled events still bubble to the row, whose double-click opens Edit Details.
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-0.5 pt-0.5">
            <div className="text-[13px] font-semibold leading-snug text-foreground">{title}</div>
            {retrying ? null : <div className="leading-snug text-muted-foreground">{reason}</div>}
          </div>
          {canRetry || canDismiss ? (
            <div className="-mr-1 -mt-0.5 flex shrink-0 items-center gap-0.5">
              {canRetry ? (
                <AutoNameAction
                  label={
                    retrying
                      ? title
                      : t('auto.components.sidebar.AutoRenameFailedDialog.tryAgain', 'Try again')
                  }
                  tooltip={t(
                    'auto.components.sidebar.AutoRenameFailedDialog.tryAgain',
                    'Try again'
                  )}
                  busy={retrying}
                  onClick={() => {
                    if (!retrying) {
                      retry.tryAgain()
                    }
                  }}
                >
                  {retrying ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
                </AutoNameAction>
              ) : null}
              {canDismiss ? (
                <AutoNameAction
                  label={t('auto.components.sidebar.AutoNameFailed.dismiss', 'Dismiss')}
                  tooltip={t('auto.components.sidebar.AutoNameFailed.dismiss', 'Dismiss')}
                  disabled={retrying || dismissing}
                  onClick={dismiss}
                >
                  <X />
                </AutoNameAction>
              ) : null}
            </div>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

function AutoNameAction({
  label,
  tooltip,
  busy = false,
  disabled = false,
  onClick,
  children
}: {
  label: string
  tooltip: string
  busy?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost-muted"
          size="icon-xs"
          aria-label={label}
          // aria-disabled keeps focus on a busy Try again; a natively disabled button drops it.
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          disabled={disabled}
          onClick={onClick}
          className="[&_svg]:size-3.5"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
