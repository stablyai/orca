import type { JSX } from 'react'
import { Loader2 } from 'lucide-react'
import type { FeatureTip, FeatureTipAction } from '../../../../shared/feature-tips'
import { Button } from '@/components/ui/button'

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
  fullWidth = false
}: {
  currentTip: FeatureTip
  primaryBusy: boolean
  onPrimaryAction: () => void
  onSkip: () => void
  showSkip?: boolean
  fullWidth?: boolean
}): JSX.Element {
  return (
    <>
      {showSkip ? (
        <Button variant="ghost" onClick={onSkip} disabled={primaryBusy}>
          Maybe Later
        </Button>
      ) : null}
      <Button
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
