import type { JSX } from 'react'
import { flushSync } from 'react-dom'
import { ArrowRight, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { FeatureWallTourDepthSummary } from '../../../../shared/feature-wall-tour-depth'
import { FeatureTourPreview } from '../feature-wall/FeatureTourPreview'
import { FeatureWallTourSurface } from '../feature-wall/FeatureWallTourSurface'
import { usePrefersReducedMotion } from '../feature-wall/feature-wall-modal-helpers'

const TOUR_LEARNING_POINTS: readonly string[] = [
  'Run agents in isolated worktrees.',
  'Orchestrate agents to finish larger tasks.',
  'Start tasks from GitHub or Linear.',
  'Send webpage elements to agents from the Orca browser.'
]

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
        detachedFooter
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
            Exit tour
          </button>
        }
      />
    )
  }

  return (
    <div className="flex h-full min-h-[430px] flex-col">
      <div className="grid w-full grid-cols-1 items-start gap-10 md:grid-cols-[1fr_minmax(0,340px)]">
        <div className="flex flex-col gap-4">
          <p className="text-sm font-medium text-foreground">Preview the core workflow.</p>
          <ul className="flex flex-col gap-2.5">
            {TOUR_LEARNING_POINTS.map((point) => (
              <li key={point} className="flex items-start gap-3">
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-foreground">
                  <Check className="size-2.5" strokeWidth={3} />
                </span>
                <span className="text-sm leading-snug text-foreground">{point}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex w-full flex-col gap-3">
          <FeatureTourPreview className="w-full" />
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <Button
              variant="default"
              onClick={handleStartTour}
              disabled={Boolean(busyLabel)}
              className="w-full gap-2"
            >
              Take the tour
              <ArrowRight className="size-4" />
            </Button>
            <div className="mt-2 text-center text-xs text-muted-foreground">~ 60 seconds</div>
          </div>
        </div>
      </div>

      <p className="mt-auto max-w-[560px] text-left text-xs leading-relaxed text-muted-foreground">
        Available later under Help &gt; Explore Orca.
      </p>
    </div>
  )
}
