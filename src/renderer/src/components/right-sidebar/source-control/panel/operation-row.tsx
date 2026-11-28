import React, { useEffect, useId, useState } from 'react'
import { MoreHorizontal, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'

export type OperationRowOperation = Exclude<GitConflictOperation, 'unknown'>

/** The one next step; absent when there is nothing to press (e.g. conflicts left with AI off). */
export type OperationRowPrimary =
  | { kind: 'resolve'; busy: boolean; onPress: () => void }
  | { kind: 'continue' | 'retry'; busy: boolean; onPress: () => void }

export type OperationRowProps = {
  operation: OperationRowOperation
  /** The branch being changed; null shows the verb alone. */
  branch: string | null
  /** A short state that stands in for the branch when the step needs attention, e.g. "Empty step". */
  detail?: string | null
  /** Extra tooltip lines: the detached HEAD, why there is no primary. */
  notes?: (string | null)[]
  primary: OperationRowPrimary | null
  abort: {
    unavailable: boolean
    busy: boolean
    reason?: string | null
    onAbort: () => void
  }
  /** Identifies what Abort would abort (workspace, host, operation, step); a change disarms it. */
  abortTargetKey: string
}

function useOperationCopy(operation: OperationRowOperation) {
  const t = useTranslate()
  if (operation === 'rebase') {
    return {
      verb: t('auto.components.sidebar.WorktreeCardHelpers.conflictRebasing', 'Rebasing'),
      abortLabel: t('auto.components.right.sidebar.SourceControl.rebaseAbortLabel', 'Abort rebase')
    }
  }
  if (operation === 'merge') {
    return {
      verb: t('auto.components.sidebar.WorktreeCardHelpers.conflictMerging', 'Merging'),
      abortLabel: t('auto.components.right.sidebar.SourceControl.540ca8f78c', 'Abort merge')
    }
  }
  const name =
    operation === 'revert'
      ? t('gitGraph.revert', 'Revert')
      : t('gitGraph.cherryPick', 'Cherry-pick')
  return {
    verb:
      operation === 'revert'
        ? t('gitGraph.reverting', 'Reverting')
        : t('auto.components.sidebar.WorktreeCardHelpers.conflictCherryPicking', 'Cherry-picking'),
    abortLabel: t('gitGraph.abortOperation', 'Abort {{operation}}', { operation: name })
  }
}

/**
 * Two lines: the verb ("Rebasing"), then the branch, muted and in the same family, so the branch
 * gets the row's full width instead of the gap between the verb and the buttons. Each line
 * truncates on its own; the trigger's tooltip carries the full text. A detail such as
 * "Check failed" takes the branch's line.
 */
function OperationLabel({
  verb,
  branch,
  detail
}: {
  verb: string
  branch: string | null
  detail: string | null
}): React.JSX.Element {
  const tail = detail ?? branch
  return (
    <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-xs leading-4 font-medium text-foreground">{verb}</span>
      {tail ? (
        <span className="truncate text-2xs leading-3.5 text-muted-foreground">{tail}</span>
      ) : null}
    </span>
  )
}

const NO_NOTES: (string | null)[] = []

const ABORT_ARM_MS = 3000
// A second press this soon is the same gesture (double-click, double-tap), not a confirmation.
const ABORT_CONFIRM_MIN_MS = 500

/**
 * First press arms Abort; a later, separate press within 3s aborts. The arm belongs to one target:
 * any change of targetKey clears it for good, so returning to an earlier target never revives it.
 */
function useArmedAbort(onAbort: () => void, targetKey: string) {
  const [arm, setArm] = useState<{ target: string; at: number | null }>({
    target: targetKey,
    at: null
  })
  let current = arm
  if (arm.target !== targetKey) {
    // Reset during render, before any press can read the old arm against the new target.
    current = { target: targetKey, at: null }
    setArm(current)
  }
  const armedAt = current.at
  useEffect(() => {
    if (armedAt === null) {
      return
    }
    const timer = window.setTimeout(
      () => setArm((state) => (state.at === armedAt ? { ...state, at: null } : state)),
      ABORT_ARM_MS
    )
    return () => window.clearTimeout(timer)
  }, [armedAt])
  return {
    armed: armedAt !== null,
    disarm: () => setArm({ target: targetKey, at: null }),
    /** Returns true only when this press aborted. */
    press: (): boolean => {
      const now = performance.now()
      // Expiry is checked here too, so a late timer can never leave a stale arm confirmable.
      if (armedAt === null || now - armedAt > ABORT_ARM_MS) {
        setArm({ target: targetKey, at: now })
        return false
      }
      if (now - armedAt < ABORT_CONFIRM_MIN_MS) {
        return false
      }
      setArm({ target: targetKey, at: null })
      onAbort()
      return true
    }
  }
}

function PrimaryButton({ primary }: { primary: OperationRowPrimary }): React.JSX.Element {
  const t = useTranslate()
  const label =
    primary.kind === 'resolve'
      ? t('auto.components.right.sidebar.SourceControl.operationResolve', 'Resolve')
      : primary.kind === 'retry'
        ? t('auto.components.right.sidebar.SourceControl.rebaseRetryInspect', 'Retry')
        : t('auto.components.right.sidebar.SourceControl.rebaseContinue', 'Continue')
  // The short visible word keeps the row calm; the accessible name says what it does.
  const ariaLabel =
    primary.kind === 'resolve'
      ? t(
          'auto.components.right.sidebar.SourceControl.operationResolveLabel',
          'Resolve conflicts with AI'
        )
      : primary.kind === 'retry'
        ? t(
            'auto.components.right.sidebar.SourceControl.rebaseRetryInspectLabel',
            'Retry checking the rebase step'
          )
        : undefined
  const button = (
    <Button
      type="button"
      variant="default"
      size="xs"
      aria-label={ariaLabel}
      aria-busy={primary.busy || undefined}
      aria-disabled={primary.busy || undefined}
      onClick={() => {
        if (!primary.busy) {
          primary.onPress()
        }
      }}
    >
      {primary.busy ? (
        <LoadingSpinner className="size-3" />
      ) : primary.kind === 'resolve' ? (
        <Sparkles aria-hidden="true" />
      ) : null}
      {label}
    </Button>
  )
  if (!ariaLabel) {
    return button
  }
  // The visible word stays short; the tooltip says what it does (the AI resolves; Retry re-reads the step).
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {ariaLabel}
      </TooltipContent>
    </Tooltip>
  )
}

function AbortMenu({
  abortLabel,
  abort,
  abortTargetKey
}: {
  abortLabel: string
  abort: OperationRowProps['abort']
  abortTargetKey: string
}): React.JSX.Element {
  const t = useTranslate()
  const armedAbort = useArmedAbort(abort.onAbort, abortTargetKey)
  const reasonId = useId()
  const moreLabel = t(
    'auto.components.right.sidebar.SourceControl.operationMoreActions',
    'More actions'
  )
  const confirmLabel = t(
    'auto.components.right.sidebar.SourceControl.operationAbortConfirm',
    'Select again to abort'
  )
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) {
          armedAbort.disarm()
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              aria-label={moreLabel}
              aria-busy={abort.busy || undefined}
            >
              {abort.busy ? (
                <LoadingSpinner className="size-3.5" />
              ) : (
                <MoreHorizontal className="size-3.5" />
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {moreLabel}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          // aria-disabled, not disabled: Radix skips disabled items, so keyboard and screen-reader
          // users could never reach the item to hear why Abort is off.
          aria-disabled={abort.unavailable || undefined}
          onKeyDown={(event) => {
            // A held Enter or Space repeats selection; only a fresh press may arm or confirm.
            if ((event.key === 'Enter' || event.key === ' ') && event.repeat) {
              event.preventDefault()
            }
          }}
          aria-describedby={abort.reason ? reasonId : undefined}
          onSelect={(event) => {
            if (abort.unavailable) {
              event.preventDefault()
              return
            }
            // Arming keeps the menu open so the confirming press lands on the same item.
            if (!armedAbort.press()) {
              event.preventDefault()
            }
          }}
        >
          {/* Weight, not colour, marks the armed state: this row stays free of red. */}
          {armedAbort.armed ? <span className="font-medium">{confirmLabel}</span> : abortLabel}
        </DropdownMenuItem>
        {abort.reason ? (
          <p id={reasonId} className="max-w-60 px-2.5 pb-1.5 text-xs text-muted-foreground">
            {abort.reason}
          </p>
        ) : null}
        {/* The menu item's text change alone may not be re-read, so arming is announced too. */}
        <span className="sr-only" aria-live="polite">
          {armedAbort.armed ? confirmLabel : null}
        </span>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A paused rebase, merge, cherry-pick or revert, drawn in place of the HEAD row: "Rebasing" over
 * "feature/x", one primary that follows the state, and a ⋯ menu holding Abort.
 */
export function OperationRow({
  operation,
  branch,
  detail = null,
  notes = NO_NOTES,
  primary,
  abort,
  abortTargetKey
}: OperationRowProps): React.JSX.Element {
  const copy = useOperationCopy(operation)
  const statusText = [copy.verb, detail ?? branch].filter(Boolean).join(' ')
  const tooltipLines = [statusText, ...notes].filter((line): line is string => Boolean(line))
  return (
    <div
      className="flex min-h-7 min-w-0 items-center gap-1.5"
      data-testid="source-control-operation-row"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="flex min-w-0 flex-1 items-center rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <OperationLabel verb={copy.verb} branch={branch} detail={detail} />
            {/* The row's one live copy, named by the status alone: the tooltip already describes the
                trigger with every line, so repeating the notes here would read them twice. */}
            <span className="sr-only" role="status" aria-live="polite">
              {statusText}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="max-w-72 break-words">
          {tooltipLines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </TooltipContent>
      </Tooltip>
      <span className="flex shrink-0 items-center gap-0.5">
        {primary ? <PrimaryButton primary={primary} /> : null}
        <AbortMenu abortLabel={copy.abortLabel} abort={abort} abortTargetKey={abortTargetKey} />
      </span>
    </div>
  )
}
