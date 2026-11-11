import React from 'react'
import { CircleSlash } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Translate } from '@/i18n/use-translate'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { StepIcon } from './WorktreeSetupSteps'
import type { VmBuildStep } from './vm-build-steps'
import { typicalStepSeconds, type VmBuildStepTiming } from './vm-build-timing'
import { formatElapsedTime } from './worktree-creation-clock'
import { stepLabel, stepStateLabel } from './vm-build-sheet-copy'

/** One timed row of the build checklist; the failure card, not the row, carries the red. */
export function VmBuildStepRow({
  step,
  cloud,
  detail,
  timing,
  t
}: {
  step: VmBuildStep
  cloud: boolean
  /** The step's measured duration, when there is one. */
  timing: VmBuildStepTiming | null
  /** What the running step is doing right now, in plain words. */
  detail: string | null
  t: Translate
}): React.JSX.Element {
  const labelId = React.useId()
  // A live percent already says how far along the step is.
  const hint = step.state === 'running' && step.percent === null ? timing : null
  const slow = hint !== null && step.elapsedMs !== null && step.elapsedMs > hint.p95Ms

  return (
    <li
      className="flex flex-col gap-1 py-1.5"
      aria-current={step.state === 'running' ? 'step' : undefined}
    >
      <div className="flex items-center gap-2.5">
        {step.skipped ? (
          <CircleSlash aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <StepIcon state={step.state} />
        )}
        <span
          id={labelId}
          className={cn(
            'min-w-0 flex-1 truncate transition-colors duration-200 motion-reduce:transition-none',
            (step.state === 'pending' || step.skipped) && 'text-muted-foreground'
          )}
        >
          {cloud && step.id === 'clone' && step.state === 'pending' && !step.cloneMode ? (
            // Clone or update is decided in a moment (boot plan); a placeholder never relabels.
            <>
              <Skeleton className="inline-block h-3 w-28 align-middle" />
              <span className="sr-only">{stepLabel(step, cloud, t)}</span>
            </>
          ) : (
            stepLabel(step, cloud, t)
          )}
        </span>
        <span className="sr-only">
          {step.skipped
            ? t('auto.components.worktree.creation.VmBuildSheet.stateSkipped', 'Skipped')
            : stepStateLabel(step.state, t)}
        </span>
        {step.skipped ? (
          <span aria-hidden className="text-xs text-muted-foreground">
            {t('auto.components.worktree.creation.VmBuildSheet.stateSkipped', 'Skipped')}
          </span>
        ) : null}
        {hint ? (
          <span className="text-xs text-muted-foreground">
            {slow
              ? t('auto.components.worktree.creation.VmBuildSheet.slow', 'Taking longer than usual')
              : t(
                  'auto.components.worktree.creation.VmBuildSheet.usually',
                  'usually ~{{seconds}}s',
                  { seconds: typicalStepSeconds(hint) }
                )}
          </span>
        ) : null}
        {step.percent !== null ? (
          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
            {step.percent}%
          </span>
        ) : null}
        {step.elapsedMs !== null && step.state !== 'pending' ? (
          <span className="min-w-12 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">
            {formatElapsedTime(step.elapsedMs)}
          </span>
        ) : null}
      </div>
      {detail ? <p className="ml-6 text-xs text-muted-foreground">{detail}</p> : null}
      {step.percent !== null ? (
        <Progress value={step.percent} aria-labelledby={labelId} className="ml-6 h-1 w-auto" />
      ) : step.state === 'running' && step.stage === 'counting' ? (
        // No percent yet: an indeterminate bar (static and dim with reduced motion), never a 0%.
        <span
          role="progressbar"
          aria-labelledby={labelId}
          className="ml-6 block h-1 overflow-hidden rounded-full bg-primary/20"
        >
          <span className="block h-full w-2/5 animate-[skill-update-slide_1.35s_ease-in-out_infinite] rounded-full bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
        </span>
      ) : null}
    </li>
  )
}
