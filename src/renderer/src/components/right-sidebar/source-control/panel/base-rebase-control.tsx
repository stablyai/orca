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
  hasGitOwner: boolean
  onRebase: () => void
  onAbortRebase: () => void
  onContinueRebase: () => void
  onRetryRebaseInspect: () => void
}

type ReasonButtonProps = Omit<React.ComponentProps<typeof Button>, 'disabled' | 'onClick'> & {
  unavailable: boolean
  reason: string | null
  onPress: () => void
}

/**
 * aria-disabled, not disabled: an unavailable button keeps focus and hover, so its tooltip can say
 * why, and a button that turns busy or available while focused keeps focus. Every state renders the
 * same node, so React never remounts it under the keyboard.
 */
function ReasonButton({
  unavailable,
  reason,
  onPress,
  children,
  ...buttonProps
}: ReasonButtonProps): React.JSX.Element {
  const reasonId = useId()
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            {...buttonProps}
            type="button"
            aria-disabled={unavailable || undefined}
            aria-describedby={reason ? reasonId : undefined}
            style={unavailable ? { cursor: 'default' } : undefined}
            onClick={(event) => {
              if (unavailable) {
                event.preventDefault()
                return
              }
              onPress()
            }}
          >
            {children}
          </Button>
        </TooltipTrigger>
        {reason ? (
          <TooltipContent side="bottom" sideOffset={6}>
            {reason}
          </TooltipContent>
        ) : null}
      </Tooltip>
      {/* Always in the DOM while there is a reason: the tooltip body only exists while it is open. */}
      {reason ? (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      ) : null}
    </>
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
  const unavailable = actions.isRebasing || state.blockedBy !== null
  return (
    <ReasonButton
      variant="outline"
      size="xs"
      unavailable={unavailable}
      reason={reason}
      aria-label={label}
      aria-busy={actions.isRebasing || undefined}
      title={unavailable ? undefined : label}
      onPress={actions.onRebase}
    >
      {actions.isRebasing ? (
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      ) : (
        // Narrow panels keep the word and drop the icon.
        <GitPullRequestArrow className="size-3 @max-[16rem]:hidden" aria-hidden="true" />
      )}
      {t('auto.components.right.sidebar.SourceControl.rebaseButton', 'Rebase')}
    </ReasonButton>
  )
}

type StepButton = {
  label: string
  ariaLabel?: string
  reason: string | null
  unavailable: boolean
  primary: boolean
  onPress: () => void
}

/** The one step the paused rebase offers next; a single slot so focus survives state changes. */
function useRebaseStepButton(
  actions: BaseRebaseActions,
  unresolvedCount: number,
  continueState: RebaseContinueState,
  inspectFailureMessage: string | null
): StepButton {
  const t = useTranslate()
  const busy = actions.isAbortingRebase || actions.isContinuingRebase || !actions.hasGitOwner
  const continueLabel = t('auto.components.right.sidebar.SourceControl.rebaseContinue', 'Continue')
  if (continueState === 'unreadable') {
    const failed = t(
      'auto.components.right.sidebar.SourceControl.rebaseStepUnreadable',
      "Couldn't check this rebase step"
    )
    return {
      label: t('auto.components.right.sidebar.SourceControl.rebaseRetryInspect', 'Retry'),
      ariaLabel: t(
        'auto.components.right.sidebar.SourceControl.rebaseRetryInspectLabel',
        'Retry checking the rebase step'
      ),
      reason: inspectFailureMessage ? `${failed}: ${inspectFailureMessage}` : failed,
      unavailable: busy,
      primary: false,
      onPress: actions.onRetryRebaseInspect
    }
  }
  const reason =
    unresolvedCount > 0
      ? t(
          'auto.components.right.sidebar.SourceControl.rebaseResolveConflictsFirst',
          'Resolve conflicts first'
        )
      : continueState === 'blocked' || continueState === 'empty'
        ? t(
            'auto.components.right.sidebar.SourceControl.rebaseStoppedFinishInTerminal',
            'Git paused this step. Finish it in a terminal or abort.'
          )
        : continueState === 'unknown'
          ? t(
              'auto.components.right.sidebar.SourceControl.rebaseCheckingStep',
              'Checking the rebase step'
            )
          : null
  return {
    label: continueLabel,
    reason: busy ? null : reason,
    unavailable: busy || reason !== null,
    // Once nothing is left to resolve, Continue is the step to take.
    primary: reason === null,
    onPress: actions.onContinueRebase
  }
}

export function RebasePausedStrip({
  actions,
  unresolvedCount,
  continueState,
  inspectFailureMessage = null
}: {
  actions: BaseRebaseActions
  unresolvedCount: number
  continueState: RebaseContinueState
  inspectFailureMessage?: string | null
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
      : continueState === 'unreadable'
        ? t(
            'auto.components.right.sidebar.SourceControl.rebaseStepUnreadableShort',
            "Couldn't check step"
          )
        : continueState === 'empty'
          ? t('auto.components.right.sidebar.SourceControl.rebaseEmptyStepShort', 'Empty step')
          : null
  const busy = actions.isAbortingRebase || actions.isContinuingRebase
  const step = useRebaseStepButton(actions, unresolvedCount, continueState, inspectFailureMessage)
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
      <ReasonButton
        variant="destructive-chip"
        size="xs"
        unavailable={busy}
        reason={null}
        // The visible word alone is ambiguous to a screen reader landing on it from elsewhere.
        aria-label={t(
          'auto.components.right.sidebar.SourceControl.rebaseAbortLabel',
          'Abort rebase'
        )}
        aria-busy={(actions.isAbortingRebase && !actions.isContinuingRebase) || undefined}
        onPress={actions.onAbortRebase}
      >
        {actions.isAbortingRebase && !actions.isContinuingRebase ? (
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        ) : null}
        {t('auto.components.right.sidebar.SourceControl.rebaseAbort', 'Abort')}
      </ReasonButton>
      <ReasonButton
        variant={step.primary ? 'default' : 'outline'}
        size="xs"
        unavailable={step.unavailable}
        reason={step.reason}
        aria-label={step.ariaLabel}
        aria-busy={actions.isContinuingRebase || undefined}
        onPress={step.onPress}
      >
        {actions.isContinuingRebase ? (
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        ) : null}
        {step.label}
      </ReasonButton>
    </div>
  )
}
