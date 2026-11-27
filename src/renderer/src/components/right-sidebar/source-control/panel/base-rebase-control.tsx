import React, { useId, useLayoutEffect, useRef, useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { BaseRebaseState, RebaseContinueState } from './base-rebase-state'

export type BaseRebaseActions = {
  state: BaseRebaseState
  isAbortingRebase: boolean
  isContinuingRebase: boolean
  isRetryingRebaseInspect: boolean
  hasGitOwner: boolean
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
  _inspectFailureMessage: string | null
): StepButton {
  const t = useTranslate()
  const busy = actions.isAbortingRebase || actions.isContinuingRebase || !actions.hasGitOwner
  const continueLabel = t('auto.components.right.sidebar.SourceControl.rebaseContinue', 'Continue')
  if (continueState === 'unreadable' || actions.isRetryingRebaseInspect) {
    return {
      label: t('auto.components.right.sidebar.SourceControl.rebaseRetryInspect', 'Retry'),
      ariaLabel: t(
        'auto.components.right.sidebar.SourceControl.rebaseRetryInspectLabel',
        'Retry checking the rebase step'
      ),
      reason: t('auto.components.right.sidebar.SourceControl.rebaseCheckAgain', 'Check again'),
      unavailable: busy || actions.isRetryingRebaseInspect,
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

function RebaseStatusLabel({
  pausedLabel,
  detailLabel
}: {
  pausedLabel: string
  detailLabel: string | null
}): React.JSX.Element {
  const slot = useRef<HTMLSpanElement>(null)
  const full = useRef<HTMLSpanElement>(null)
  const detail = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState<'full' | 'detail' | 'none'>('none')
  useLayoutEffect(() => {
    const measure = () => {
      const width = slot.current?.clientWidth ?? 0
      setVisible(
        width >= (full.current?.scrollWidth ?? Infinity)
          ? 'full'
          : detailLabel && width >= (detail.current?.scrollWidth ?? Infinity)
            ? 'detail'
            : 'none'
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (slot.current) {
      observer.observe(slot.current)
    }
    return () => observer.disconnect()
  }, [pausedLabel, detailLabel])
  const fullLabel = detailLabel ? `${pausedLabel} · ${detailLabel}` : pausedLabel
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="img"
            aria-label={fullLabel}
            className="shrink-0 rounded-sm focus-visible:ring-1 focus-visible:ring-ring"
          >
            <TriangleAlert className="size-3.5 text-destructive" aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{fullLabel}</TooltipContent>
      </Tooltip>
      <span
        ref={slot}
        role="status"
        aria-live="polite"
        className="relative min-w-0 flex-1 whitespace-nowrap text-foreground"
      >
        <span
          ref={full}
          aria-hidden="true"
          className="pointer-events-none invisible absolute whitespace-nowrap"
        >
          {fullLabel}
        </span>
        <span
          ref={detail}
          aria-hidden="true"
          className="pointer-events-none invisible absolute whitespace-nowrap"
        >
          {detailLabel}
        </span>
        {/* Why: a narrow strip may show only part of the label or none; the live region still announces all of it. */}
        <span className="sr-only">{fullLabel}</span>
        <span aria-hidden="true">
          {visible === 'full' ? fullLabel : visible === 'detail' ? detailLabel : null}
        </span>
      </span>
    </>
  )
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
        ? t('auto.components.right.sidebar.SourceControl.rebaseStepUnreadableShort', 'Check failed')
        : continueState === 'empty'
          ? t('auto.components.right.sidebar.SourceControl.rebaseEmptyStepShort', 'Empty step')
          : null
  const busy = actions.isAbortingRebase || actions.isContinuingRebase
  const step = useRebaseStepButton(actions, unresolvedCount, continueState, inspectFailureMessage)
  return (
    <div className="@container -mx-1 flex min-h-7 min-w-0 items-center gap-1.5 rounded-md bg-destructive/10 px-1 py-0.5">
      <RebaseStatusLabel pausedLabel={pausedLabel} detailLabel={detailLabel} />
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
        aria-busy={actions.isContinuingRebase || actions.isRetryingRebaseInspect || undefined}
        onPress={step.onPress}
      >
        {actions.isContinuingRebase || actions.isRetryingRebaseInspect ? (
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        ) : null}
        {step.label}
      </ReasonButton>
    </div>
  )
}
