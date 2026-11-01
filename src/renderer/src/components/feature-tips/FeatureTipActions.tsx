import type { JSX, Ref } from 'react'
import { Loader2 } from 'lucide-react'
import type { FeatureTip, FeatureTipAction } from '../../../../shared/feature-tips'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { getLocalizedFeatureTipCopy } from './feature-tip-localized-copy'

function getPrimaryBusyLabel(action: FeatureTipAction): string {
  if (action === 'setup-cli') {
    return translate('auto.components.feature.tips.FeatureTipActions.installing', 'Installing...')
  }
  if (action === 'enable-session-search') {
    return translate('auto.components.feature.tips.FeatureTipActions.turningOn', 'Turning on...')
  }
  return translate('auto.components.feature.tips.FeatureTipActions.working', 'Working...')
}

export function FeatureTipActions({
  currentTip,
  primaryBusy,
  onPrimaryAction,
  onSkip,
  showSkip = true,
  fullWidth = false,
  primaryButtonRef,
  label,
  secondaryLabel
}: {
  currentTip: FeatureTip
  primaryBusy: boolean
  onPrimaryAction: () => void
  onSkip: () => void
  showSkip?: boolean
  /** Fills the footer row, or what a sibling button leaves of it. */
  fullWidth?: boolean
  primaryButtonRef?: Ref<HTMLButtonElement>
  /** Overrides the tip's CTA for tips whose button changes with their state. */
  label?: string
  /** Overrides the secondary button's default "Maybe Later". */
  secondaryLabel?: string
}): JSX.Element {
  return (
    <>
      {showSkip ? (
        <Button variant="ghost" onClick={onSkip} disabled={primaryBusy}>
          {secondaryLabel ??
            translate('auto.components.feature.tips.FeatureTipActions.eb04abece8', 'Maybe Later')}
        </Button>
      ) : null}
      <Button
        ref={primaryButtonRef}
        className={fullWidth ? 'w-full flex-1' : undefined}
        onClick={onPrimaryAction}
        disabled={primaryBusy}
      >
        {primaryBusy ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            {getPrimaryBusyLabel(currentTip.action)}
          </>
        ) : (
          (label ?? getLocalizedFeatureTipCopy(currentTip).ctaLabel)
        )}
      </Button>
    </>
  )
}
