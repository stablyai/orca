import React, { useId } from 'react'
import { GitPullRequestArrow, Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { BaseRebaseState, RebaseContinueState } from './base-rebase-state'

export type BaseRebaseActions = {
  state: BaseRebaseState
  isRebasing: boolean
  isAbortingRebase: boolean
  isContinuingRebase: boolean
  onRebase: () => void
  onAbortRebase: () => void
  onContinueRebase: () => void
}

/** Disabled buttons drop pointer and focus events, so the reason sits on a focusable wrapper. */
function ButtonWithReason({
  reason,
  children
}: {
  reason: string | null
  children: (describedBy: string | undefined) => React.ReactElement
}): React.JSX.Element {
  const reasonId = useId()
  if (!reason) {
    return children(undefined)
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
          tabIndex={0}
          aria-describedby={reasonId}
        >
          {children(reasonId)}
          {/* Always in the DOM: the tooltip body only exists while it is open. */}
          <span id={reasonId} className="sr-only">
            {reason}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {reason}
      </TooltipContent>
    </Tooltip>
  )
}

export function BaseRebaseTrailing({
  actions
}: {
  actions: BaseRebaseActions
}): React.JSX.Element | null {
  const t = useTranslate()
  const { state } = actions
  if (state.kind === 'up_to_date') {
    return (
      <span className="shrink-0 text-muted-foreground/70">
        {t('auto.components.right.sidebar.SourceControl.baseUpToDate', 'Up to date')}
      </span>
    )
  }
  if (state.kind !== 'behind') {
    return null
  }
  const label = t(
    'auto.components.right.sidebar.source.control.dropdown.items.rebaseOntoNamedBase',
    'Rebase onto {{base}}',
    {
      base: state.baseLabel
    }
  )
  const reason = actions.isRebasing
    ? null
    : state.blockedBy === 'dirty'
      ? t(
          'auto.components.right.sidebar.source.control.dropdown.items.rebaseCommitOrStashFirst',
          'Commit or stash changes first'
        )
      : state.blockedBy === 'busy'
        ? t(
            'auto.components.right.sidebar.SourceControl.rebaseOperationInProgress',
            'Wait for the current Git operation to finish'
          )
        : null
  const disabled = actions.isRebasing || state.blockedBy !== null
  const button = (describedBy: string | undefined) => (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={disabled}
      aria-label={label}
      aria-describedby={describedBy}
      aria-busy={actions.isRebasing || undefined}
      title={disabled ? undefined : label}
      onClick={actions.onRebase}
    >
      {actions.isRebasing ? (
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      ) : (
        // Narrow panels keep the word and drop the icon.
        <GitPullRequestArrow className="size-3 @max-[16rem]:hidden" aria-hidden="true" />
      )}
      {t('auto.components.right.sidebar.SourceControl.rebaseButton', 'Rebase')}
    </Button>
  )
  return <ButtonWithReason reason={reason}>{button}</ButtonWithReason>
}

export function RebasePausedStrip({
  actions,
  unresolvedCount,
  continueState
}: {
  actions: BaseRebaseActions
  unresolvedCount: number
  continueState: RebaseContinueState
}): React.JSX.Element {
  const t = useTranslate()
  const pausedLabel = t('auto.components.right.sidebar.SourceControl.rebasePaused', 'Rebase paused')
  const detailLabel =
    unresolvedCount > 0
      ? t(
          'auto.components.right.sidebar.SourceControl.rebaseConflictCount',
          '{{count}} conflicts',
          {
            count: unresolvedCount,
            defaultValue_one: '{{count}} conflict'
          }
        )
      : null
  const busy = actions.isAbortingRebase || actions.isContinuingRebase
  const continueReason =
    unresolvedCount > 0
      ? t(
          'auto.components.right.sidebar.SourceControl.rebaseResolveConflictsFirst',
          'Resolve conflicts first'
        )
      : null
  const stepSpinner = actions.isContinuingRebase ? (
    <Loader2 className="size-3 animate-spin" aria-hidden="true" />
  ) : null
  return (
    <div className="@container -mx-1 flex min-h-7 min-w-0 items-center gap-1.5 rounded-md bg-destructive/10 px-1 py-0.5">
      <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate text-foreground">
        {detailLabel ? (
          <>
            {/* Narrow panels keep only the detail, which is the actionable part. */}
            <span className="@max-[17.25rem]:hidden">{pausedLabel} · </span>
            {detailLabel}
          </>
        ) : (
          pausedLabel
        )}
      </span>
      <Button
        type="button"
        variant="destructive-chip"
        size="xs"
        disabled={busy}
        onClick={actions.onAbortRebase}
      >
        {actions.isAbortingRebase && !actions.isContinuingRebase ? (
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        ) : null}
        {t('auto.components.right.sidebar.SourceControl.rebaseAbort', 'Abort')}
      </Button>
      {/* Git cannot continue this stop (nothing to commit, or its own pause): Abort only. */}
      {continueState === 'blocked' ? null : (
        <ButtonWithReason reason={continueReason}>
          {(describedBy) => (
            <Button
              type="button"
              // Once nothing is left to resolve, Continue is the step to take.
              variant={unresolvedCount === 0 && continueState === 'ready' ? 'default' : 'outline'}
              size="xs"
              disabled={busy || unresolvedCount > 0 || continueState !== 'ready'}
              aria-describedby={describedBy}
              onClick={actions.onContinueRebase}
            >
              {stepSpinner}
              {t('auto.components.right.sidebar.SourceControl.rebaseContinue', 'Continue')}
            </Button>
          )}
        </ButtonWithReason>
      )}
    </div>
  )
}
