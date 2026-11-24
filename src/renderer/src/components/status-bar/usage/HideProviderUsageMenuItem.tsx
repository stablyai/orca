import React from 'react'
import { EyeOff } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../../store'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getProviderDisplayName } from '../../../../../shared/agent-usage/display/usage-provider-windows'

// Makes the status bar's right-click toggle discoverable so abandoned providers can be dismissed.
export function HideProviderUsageMenuItem({
  provider
}: {
  provider: ProviderRateLimits['provider']
}): React.JSX.Element {
  const t = useTranslate()
  const setStatusBarItemVisible = useAppStore((s) => s.setStatusBarItemVisible)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  return (
    <DropdownMenuItem
      onSelect={() => {
        recordFeatureInteraction('usage-tracking')
        void setStatusBarItemVisible(provider, false)
      }}
    >
      <EyeOff className="size-3.5" />
      <span className="min-w-0 flex-1">
        {t('auto.components.status.bar.HideProviderUsageMenuItem.hide', 'Hide {{provider}} usage', {
          provider: getProviderDisplayName(provider)
        })}
      </span>
      <span className="text-[11px] text-muted-foreground/70">
        {t(
          'auto.components.status.bar.HideProviderUsageMenuItem.restoreHint',
          'Right-click status bar to restore'
        )}
      </span>
    </DropdownMenuItem>
  )
}
