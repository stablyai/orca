import React from 'react'
import { EyeOff, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../../store'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getProviderDisplayName } from '../../../../../shared/agent-usage/display/usage-provider-windows'
import { isOwnerNotSetUpPlaceholder } from './owner-usage-rate-limits'

type ProviderId = ProviderRateLimits['provider']

// Same switch as the status bar's right-click menu, so either path can restore it.
function useHideProviderUsage(provider: ProviderId): () => void {
  const setStatusBarItemVisible = useAppStore((s) => s.setStatusBarItemVisible)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  return () => {
    recordFeatureInteraction('usage-tracking')
    void setStatusBarItemVisible(provider, false)
  }
}

// Makes the status bar's right-click toggle discoverable so abandoned providers can be dismissed.
export function HideProviderUsageMenuItem({
  provider
}: {
  provider: ProviderId
}): React.JSX.Element {
  const t = useTranslate()
  const hide = useHideProviderUsage(provider)
  return (
    <DropdownMenuItem onSelect={hide}>
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

// Hover × in a roster row; the keyboard path is the flyout item above (menus skip nested buttons).
export function HideProviderUsageButton({
  p
}: {
  p: ProviderRateLimits
}): React.JSX.Element | null {
  const t = useTranslate()
  const hide = useHideProviderUsage(p.provider)
  const label = t(
    'auto.components.status.bar.HideProviderUsageMenuItem.hide',
    'Hide {{provider}} usage',
    { provider: getProviderDisplayName(p.provider) }
  )
  // Swallow the press so the enclosing menu row neither selects nor opens its flyout.
  const stop = (event: React.SyntheticEvent): void => event.stopPropagation()
  // A remote host's not-set-up placeholder is not a meter the user can hide.
  if (isOwnerNotSetUpPlaceholder(p)) {
    return null
  }
  return (
    // Visible on hover/focus and while the row's flyout is open, when focus has left the row.
    <span className="-my-0.5 shrink-0 opacity-0 in-data-[highlighted]:opacity-100 in-[[data-slot=dropdown-menu-sub-trigger][data-state=open]]:opacity-100">
      <Button
        variant="ghost"
        size="icon-xs"
        tabIndex={-1}
        aria-label={label}
        title={label}
        onPointerDown={stop}
        onPointerUp={stop}
        onClick={(event) => {
          stop(event)
          hide()
        }}
      >
        <X />
      </Button>
    </span>
  )
}
