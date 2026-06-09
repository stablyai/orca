import type { JSX } from 'react'
import { flushSync } from 'react-dom'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { FeatureWallTourDepthSummary } from '../../../../shared/feature-wall-tour-depth'
import { FeatureTourPreview } from '../feature-wall/FeatureTourPreview'
import { FeatureWallTourSurface } from '../feature-wall/FeatureWallTourSurface'
import { usePrefersReducedMotion } from '../feature-wall/feature-wall-modal-helpers'
import { translate } from '@/i18n/i18n'

type OnboardingTourStepProps = {
  tourStarted: boolean
  busyLabel: string | null
  onStartTour: () => void
  onCompleteTour: (markSuccessfulExit?: () => void) => boolean | void | Promise<boolean | void>
  onExitTour: () => void
  onTourDepthSummaryChange: (summary: FeatureWallTourDepthSummary) => void
}

type ViewTransition = {
  finished: Promise<void>
}

type DocumentWithOptionalViewTransition = Document & {
  startViewTransition?: (updateCallback: () => void | Promise<void>) => ViewTransition
}

export function OnboardingTourStep({
  tourStarted,
  busyLabel,
  onStartTour,
  onCompleteTour,
  onExitTour,
  onTourDepthSummaryChange
}: OnboardingTourStepProps): JSX.Element {
  const prefersReducedMotion = usePrefersReducedMotion()

  const handleStartTour = (): void => {
    if (busyLabel) {
      return
    }
    const doc = document as DocumentWithOptionalViewTransition
    if (prefersReducedMotion || typeof doc.startViewTransition !== 'function') {
      onStartTour()
      return
    }

    const root = document.documentElement
    let didStart = false
    root.classList.add('onboarding-tour-start-transition')
    try {
      // Why: starting the inline feature wall rewrites the page shell; a view
      // transition cross-fades the compact intro into the wide tour surface.
      const transition = doc.startViewTransition(() => {
        didStart = true
        flushSync(onStartTour)
      })
      void transition.finished.finally(() => {
        root.classList.remove('onboarding-tour-start-transition')
      })
    } catch {
      root.classList.remove('onboarding-tour-start-transition')
      if (!didStart) {
        onStartTour()
      }
    }
  }

  if (tourStarted) {
    return (
      <FeatureWallTourSurface
        isOpen
        source="onboarding"
        onDone={onCompleteTour}
        doneLabel="Continue to project setup"
        footerText={null}
        compactRail
        onTourDepthSummaryChange={onTourDepthSummaryChange}
        className="h-full min-h-0"
        panelClassName="rounded-xl border border-border bg-card"
        leadingFooterContent={
          <button
            type="button"
            className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:text-muted-foreground"
            disabled={Boolean(busyLabel)}
            onClick={onExitTour}
          >
            {translate('auto.components.onboarding.OnboardingTourStep.60c5576353', 'Exit tour')}
          </button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <FeatureTourPreview />
      <Button onClick={handleStartTour} disabled={Boolean(busyLabel)} className="gap-2 self-start">
        {translate('auto.components.onboarding.OnboardingTourStep.3f9586c043', 'Take the tour')}
        <ArrowRight className="size-4" />
      </Button>
    </div>
  )
}
