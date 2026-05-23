import type { JSX } from 'react'
import { flushSync } from 'react-dom'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FeatureTourPreview } from '../feature-wall/FeatureTourPreview'
import { FeatureWallTourSurface } from '../feature-wall/FeatureWallTourSurface'
import { usePrefersReducedMotion } from '../feature-wall/feature-wall-modal-helpers'

type OnboardingTourStepProps = {
  tourStarted: boolean
  busyLabel: string | null
  onStartTour: () => void
  onCompleteTour: () => void | Promise<void>
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
  onCompleteTour
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
        detachedFooter
        className="h-full max-h-[790px] min-h-0"
        panelClassName="rounded-xl border border-border bg-card"
      />
    )
  }

  return (
    <div className="flex h-full min-h-[430px] flex-col">
      <div className="mx-auto flex w-full max-w-[560px] flex-col items-center gap-5 pt-16 text-center">
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Interested in Orca&apos;s advanced features?
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Take a short workflow tour before choosing your first project.
          </p>
        </div>

        <div className="flex w-full flex-col items-center gap-3">
          <FeatureTourPreview className="w-full max-w-[360px]" />
          <Button
            variant="default"
            onClick={handleStartTour}
            disabled={Boolean(busyLabel)}
            className="w-full max-w-[360px] justify-center gap-2"
          >
            Take the tour
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>

      <p className="mx-auto mt-auto max-w-[560px] text-center text-xs leading-relaxed text-muted-foreground">
        This tour can be seen anytime under Help &gt; Explore Orca.
      </p>
    </div>
  )
}
