import React from 'react'
import { CircleSlash } from 'lucide-react'
import { cn } from '@/lib/class-names'
import type { Translate } from '@/i18n/use-translate'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { StepIcon } from './WorktreeSetupSteps'
import type { VmBuildStep } from './vm-build-steps'
import {
  SLOW_WITHOUT_MEASURE_MS,
  typicalStepSeconds,
  type VmBuildStepTiming
} from './vm-build-timing'
import { formatElapsedTime } from './worktree-creation-clock'
import { stepLabel, stepStateLabel } from './vm-build-sheet-copy'

/** The boot plan usually answers within this; only a slower answer shows the placeholder. */
const PLACEHOLDER_DELAY_MS = 150

/** True once `active` has held for `delayMs` (the row's mode is unknown only once per create). */
function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [due, setDue] = React.useState(false)
  React.useEffect(() => {
    if (!active) {
      return
    }
    const timer = window.setTimeout(() => setDue(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [active, delayMs])
  return active && due
}

/** One timed row of the build checklist; the failure card, not the row, carries the red. */
export function VmBuildStepRow({
  step,
  cloud,
  detail,
  timing,
  stopped = false,
  t,
  waitedMs = 0
}: {
  step: VmBuildStep
  cloud: boolean
  /** The build stopped (a failure card shows): an undecided clone/update never will be decided. */
  stopped?: boolean
  /** The step's measured duration, when there is one. */
  timing: VmBuildStepTiming | null
  /** What the running step is doing right now, in plain words. */
  detail: string | null
  t: Translate
  /**
   * How long the create has been running (the sandbox step's time). Past PLACEHOLDER_DELAY_MS the
   * boot plan had its chance to answer, so a still-unknown row shows its placeholder at once: no
   * blank row, also not in a fixture or a remount.
   */
  waitedMs?: number
}): React.JSX.Element {
  const labelId = React.useId()
  // A live percent already says how far along the step is.
  const measuring = step.state === 'running' && step.percent === null
  const hint = measuring ? timing : null
  // Past the measured p95; with no measurement yet, a sandbox start only after 30 s (JA-11).
  const slowAfterMs =
    timing?.p95Ms ?? (cloud && step.id === 'provision' ? SLOW_WITHOUT_MEASURE_MS : null)
  const slow =
    measuring && slowAfterMs !== null && step.elapsedMs !== null && step.elapsedMs > slowAfterMs
  const undecided = cloud && step.id === 'clone' && step.state === 'pending' && !step.cloneMode
  // N-12: once the start has failed, the mode stays unknown for good: name the step neutrally.
  const modeUnknown = undecided && !stopped
  const placeholderDelayed = useDelayedFlag(modeUnknown, PLACEHOLDER_DELAY_MS)
  const placeholderDue = modeUnknown && (placeholderDelayed || waitedMs >= PLACEHOLDER_DELAY_MS)

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
          {modeUnknown ? (
            // Clone or update is decided in a moment (boot plan): a placeholder, never a guessed label.
            // Usually decided within ~150 ms, so the placeholder shows only after that (no blink).
            <>
              <span className="sr-only">
                {t(
                  'auto.components.worktree.creation.VmBuildSheet.repositoryPending',
                  'Repository'
                )}
              </span>
              {placeholderDue ? (
                <Skeleton className="inline-block h-3 w-28 align-middle" />
              ) : (
                <span aria-hidden className="invisible">
                  {'\u00a0'}
                </span>
              )}
            </>
          ) : undecided ? (
            t('auto.components.worktree.creation.VmBuildSheet.getRepository', 'Get repository')
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
        {slow || hint ? (
          <span className="text-xs text-muted-foreground">
            {slow || !hint
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
