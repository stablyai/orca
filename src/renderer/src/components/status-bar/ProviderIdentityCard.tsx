import React from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { translate } from '@/i18n/i18n'
import { formatTimeAgo, getProviderDisplayName, ProviderIcon, ProviderPanel } from './tooltip'

/** Puts the account above its usage in one card, so the numbers visibly belong to it. */
export function ProviderIdentityCard({
  p,
  identity,
  footer,
  showResetCredits,
  usagePercentageDisplay
}: {
  p: ProviderRateLimits
  /** Omitted when the account behind this usage can't be named reliably. */
  identity?: React.ReactNode
  footer?: React.ReactNode
  showResetCredits: boolean
  usagePercentageDisplay: UsagePercentageDisplay
}): React.JSX.Element {
  return (
    <div className="w-full space-y-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          <ProviderIcon provider={p.provider} />
          {getProviderDisplayName(p.provider)}
        </div>
        <div className="shrink-0 text-muted-foreground/80">
          {p.updatedAt
            ? translate('auto.components.status.bar.tooltip.updatedAgo', 'Updated {{time}}', {
                time: formatTimeAgo(p.updatedAt)
              })
            : translate('auto.components.status.bar.tooltip.notYetUpdated', 'Not yet updated')}
        </div>
      </div>
      <div className="space-y-3 rounded-lg bg-muted/60 p-2.5">
        {identity}
        <ProviderPanel
          p={p}
          embedded
          showResetCredits={showResetCredits}
          usagePercentageDisplay={usagePercentageDisplay}
        />
        {footer}
      </div>
    </div>
  )
}
