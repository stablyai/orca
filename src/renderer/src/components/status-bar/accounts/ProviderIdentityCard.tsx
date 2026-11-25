import React from 'react'
import { Card } from '@/components/ui/card'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { useTranslate } from '@/i18n/use-translate'
import { getProviderDisplayName } from '../../../../../shared/agent-usage/display/usage-provider-windows'
import { formatTimeAgo, ProviderIcon, ProviderPanel } from '../usage/provider-usage-panel'
import { UsageDisplayToggle } from '../usage/usage-meter'

export function ProviderIdentityCard({
  p,
  accountLabel,
  footer,
  usageSignInHint,
  statusContent,
  usagePercentageDisplay,
  inMenu = false
}: {
  p: ProviderRateLimits
  accountLabel?: string
  statusContent?: React.ReactNode
  footer?: React.ReactNode
  usageSignInHint?: string
  usagePercentageDisplay: UsagePercentageDisplay
  /** Inside a dropdown, the Used/Left toggle must be a menu item to stay keyboard reachable. */
  inMenu?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="w-full space-y-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <ProviderIcon provider={p.provider} />
          {getProviderDisplayName(p.provider)}
        </div>
        <span className="shrink-0 text-muted-foreground">
          {p.updatedAt
            ? t('auto.components.status.bar.tooltip.updatedAgo', 'Updated {{time}}', {
                time: formatTimeAgo(p.updatedAt, t)
              })
            : t('auto.components.status.bar.tooltip.notYetUpdated', 'Not yet updated')}
        </span>
      </div>
      <Card size="sm">
        <div className="space-y-3 px-2.5">
          <div className="flex items-center justify-between gap-2">
            {/* min-h-5: an unknown owner's empty name keeps the line, so the card doesn't move when it arrives. */}
            <div className="min-h-5 min-w-0 truncate text-sm font-medium" title={accountLabel}>
              {accountLabel}
            </div>
            {usageSignInHint ? null : <UsageDisplayToggle asMenuItem={inMenu} />}
          </div>
          {statusContent ?? (
            <ProviderPanel
              p={p}
              embedded
              showResetCredits={false}
              usageSignInHint={usageSignInHint}
              usagePercentageDisplay={usagePercentageDisplay}
            />
          )}
          {footer}
        </div>
      </Card>
    </div>
  )
}
