import type { JSX, Ref } from 'react'
import { Loader2 } from 'lucide-react'
import type { FeatureTip, FeatureTipAction } from '../../../../shared/feature-tips'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

function getPrimaryBusyLabel(action: FeatureTipAction): string {
  if (action === 'setup-cli') {
    return 'Installing...'
  }
  return 'Working...'
}

export function FeatureTipActions({
  currentTip,
  primaryBusy,
  onPrimaryAction,
  onSkip,
  showSkip = true,
  fullWidth = false,
  primaryButtonRef
}: {
  currentTip: FeatureTip
  primaryBusy: boolean
  onPrimaryAction: () => void
  onSkip: () => void
  showSkip?: boolean
  fullWidth?: boolean
  primaryButtonRef?: Ref<HTMLButtonElement>
}): JSX.Element {
  return (
    <>
      {showSkip ? (
        <Button variant="ghost" onClick={onSkip} disabled={primaryBusy}>
          {translate('auto.components.feature.tips.FeatureTipActions.eb04abece8', 'Maybe Later')}
        </Button>
      ) : null}
      <Button
        ref={primaryButtonRef}
        className={fullWidth ? 'w-full' : undefined}
        onClick={onPrimaryAction}
        disabled={primaryBusy}
      >
        {primaryBusy ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            {getPrimaryBusyLabel(currentTip.action)}
          </>
        ) : (
          currentTip.ctaLabel
        )}
      </Button>
    </>
  )
}
