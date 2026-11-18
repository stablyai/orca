import { useRef, type JSX } from 'react'
import type { FeatureTip } from '../../../../shared/feature-education/feature-tips'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { BotsFleetStoryVisual } from './BotsFleetStoryVisual'
import { fleetStoryFrame } from './bots-fleet-story-timeline'
import { FeatureTipActions } from './FeatureTipActions'
import {
  FEATURE_TIP_BUTTONS_ON_CARD_EDGE,
  FeatureTipDialogFrame,
  FeatureTipEyebrow
} from './FeatureTipDialogFrame'
import { useBotsFleetStoryPlayback } from './use-bots-fleet-story-playback'

export function BotsTeammateTipDialog({
  open,
  tip,
  onOpenChange,
  onPrimaryAction,
  onSkip
}: {
  open: boolean
  tip: FeatureTip
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
  onSkip: () => void
}): JSX.Element {
  const t = useTranslate()
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const playback = useBotsFleetStoryPlayback(open)
  // The steps light up in sync with the story on the right.
  const beat = fleetStoryFrame(playback.t).beat
  const steps = [
    t('featureTips.botsTeammate.stepAsk', 'Message it from anywhere'),
    t('featureTips.botsTeammate.stepFleet', 'It runs a fleet of agents'),
    t('featureTips.botsTeammate.stepReview', 'You review the PR')
  ]

  return (
    <FeatureTipDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        // Why: longer locales overflow the fixed frame; scrolling to the button would hide the title.
        primaryButtonRef.current?.focus({ preventScroll: true })
      }}
      visual={<BotsFleetStoryVisual playback={playback} />}
      copyClassName={FEATURE_TIP_BUTTONS_ON_CARD_EDGE}
    >
      <DialogHeader className="text-left">
        <div>
          <FeatureTipEyebrow label={t('featureTips.eyebrowNew', 'New')} />
          <DialogTitle size="display">
            {t('featureTips.botsTeammate.title', 'Meet your AI teammate')}
          </DialogTitle>
          <DialogDescription className="mt-3 max-w-2xl">
            {t(
              'featureTips.botsTeammate.description',
              'Ask from anywhere. It runs a fleet of agents and remembers what it learns.'
            )}
          </DialogDescription>
          <ol className="mt-5 flex flex-col gap-1">
            {steps.map((step, index) => {
              // Reduced motion and the finished frame light every step.
              const lit = playback.finished || beat === index
              const passed = !playback.finished && beat > index
              return (
                <li
                  key={step}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors duration-300',
                    lit ? 'text-foreground' : 'text-muted-foreground',
                    beat === index && !playback.finished && 'bg-accent/60'
                  )}
                >
                  <span
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs tabular-nums transition-colors duration-300',
                      lit || passed
                        ? 'border-foreground/40 text-foreground'
                        : 'border-border text-muted-foreground'
                    )}
                  >
                    {index + 1}
                  </span>
                  {step}
                </li>
              )
            })}
          </ol>
        </div>
      </DialogHeader>

      <DialogFooter className="mt-8 flex motion-reduce:mt-6 sm:justify-stretch">
        <FeatureTipActions
          currentTip={tip}
          primaryBusy={false}
          onPrimaryAction={onPrimaryAction}
          onSkip={onSkip}
          fullWidth
          primaryButtonRef={primaryButtonRef}
          secondaryLabel={t('featureTips.botsTeammate.later', 'Maybe later')}
        />
      </DialogFooter>
    </FeatureTipDialogFrame>
  )
}
