import React from 'react'
import { Card } from '@/components/ui/card'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { translate } from '@/i18n/i18n'
import { formatTimeAgo, getProviderDisplayName, ProviderIcon, ProviderPanel } from './tooltip'

export function ProviderIdentityCard({
  p,
  accountLabel,
  footer,
  usagePercentageDisplay
}: {
  p: ProviderRateLimits
  accountLabel?: string
  footer?: React.ReactNode
  usagePercentageDisplay: UsagePercentageDisplay
}): React.JSX.Element {
  return (
    <div className="w-full space-y-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <ProviderIcon provider={p.provider} />
          {getProviderDisplayName(p.provider)}
        </div>
        <span className="shrink-0 text-muted-foreground">
          {p.updatedAt
            ? translate('auto.components.status.bar.tooltip.updatedAgo', 'Updated {{time}}', {
                time: formatTimeAgo(p.updatedAt)
              })
            : translate('auto.components.status.bar.tooltip.notYetUpdated', 'Not yet updated')}
        </span>
      </div>
      <Card size="sm">
        <div className="space-y-3 px-2.5">
          {accountLabel ? (
            <div className="min-w-0 break-words text-sm font-medium">{accountLabel}</div>
          ) : null}
          <ProviderPanel
            p={p}
            embedded
            showResetCredits={false}
            usagePercentageDisplay={usagePercentageDisplay}
          />
          {footer}
        </div>
      </Card>
    </div>
  )
}
