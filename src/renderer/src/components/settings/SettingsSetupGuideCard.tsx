import { ArrowRight, ListChecks } from 'lucide-react'
import { useMemo } from 'react'
import {
  getFeatureWallSetupSteps,
  getFirstIncompleteFeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import type { FeatureWallSetupStepId } from '../../../../shared/feature-wall-setup-steps'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { useSetupGuideProgress } from '../setup-guide/use-setup-guide-progress'

export function SettingsSetupGuideCard(): React.JSX.Element | null {
  const openModal = useAppStore((s) => s.openModal)
  const progress = useSetupGuideProgress(true, false, false)
  const setupSteps = useMemo(() => getFeatureWallSetupSteps(), [])
  const unfinishedSteps = useMemo(
    () => setupSteps.filter((step) => !progress.stepDone[step.id]),
    [progress.stepDone, setupSteps]
  )
  const completedStepCount = useMemo(
    () => setupSteps.filter((step) => progress.stepDone[step.id]).length,
    [progress.stepDone, setupSteps]
  )
  const firstUnfinishedStepId: FeatureWallSetupStepId = getFirstIncompleteFeatureWallSetupStepId(
    progress.stepDone
  )
  const setupComplete = unfinishedSteps.length === 0

  return (
    <section className="rounded-xl border border-border/60 bg-card/50 px-5 py-4">
      <div className="flex items-start justify-between gap-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
            <ListChecks className="size-4" />
          </span>
          <div className="min-w-0 space-y-3">
            <div className="space-y-1">
              <h2 className="text-base font-semibold leading-tight text-foreground">
                Getting started with Orca
              </h2>
              <p className="text-sm text-muted-foreground">
                {completedStepCount}/{setupSteps.length} setup tasks complete
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                {setupComplete ? 'Status' : 'To do'}
              </p>
              <div className="flex flex-wrap gap-2">
                {setupComplete ? (
                  <span className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground">
                    All core workflows complete
                  </span>
                ) : (
                  <>
                    {unfinishedSteps.slice(0, 3).map((step) => (
                      <span
                        key={step.id}
                        className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground"
                      >
                        {step.name}
                      </span>
                    ))}
                    {unfinishedSteps.length > 3 ? (
                      <span className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground">
                        +{unfinishedSteps.length - 3} more
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          className="w-fit shrink-0 whitespace-nowrap gap-1.5"
          onClick={() => openModal('setup-guide', { setupStepId: firstUnfinishedStepId })}
        >
          {setupComplete ? 'Review setup' : 'Continue setup'}
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </section>
  )
}
