import type React from 'react'
import { useAppStore } from '../../store'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { normalizeStatusBarUsageWindowKeys } from '../../../../shared/status-bar-usage-windows'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import { SettingsRow } from './SettingsFormControls'
import { getStatusBarUsageWindowsEntry } from './appearance-usage-percentage-search'
import { getProviderDisplayName } from '../status-bar/tooltip'
import {
  formatPickedUsageName,
  listPickableUsageWindows
} from '../status-bar/status-bar-provider-usage'

/** Per-provider window picker; the options come from what each provider's snapshot reports. */
export function StatusBarUsageWindowsSetting(): React.JSX.Element {
  const rateLimits = useAppStore((state) => state.rateLimits)
  const statusBarItems = useAppStore((state) => state.statusBarItems)
  const picksByProvider = useAppStore((state) => state.statusBarUsageWindows)
  const setPicks = useAppStore((state) => state.setStatusBarUsageWindows)
  const entry = getStatusBarUsageWindowsEntry()
  const providers = [
    rateLimits.claude,
    rateLimits.codex,
    rateLimits.gemini,
    rateLimits.opencodeGo,
    rateLimits.kimi,
    rateLimits.antigravity,
    rateLimits.minimax,
    rateLimits.grok,
    rateLimits.cursor,
    rateLimits.zcode
  ]
    .filter((p): p is ProviderRateLimits => p !== null && statusBarItems.includes(p.provider))
    .map((p) => ({ p, options: listPickableUsageWindows(p) }))
    .filter(({ options }) => options.length > 0)

  return (
    <div className="py-1">
      <SettingsRow label={entry.title} description={entry.description} control={null} />
      {providers.length === 0 ? (
        <p className="pb-3 text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.StatusBarUsageWindowsSetting.empty',
            'No provider has reported usage yet.'
          )}
        </p>
      ) : (
        providers.map(({ p, options }) => {
          const name = getProviderDisplayName(p.provider)
          return (
            <SettingsRow
              key={p.provider}
              label={name}
              alignTop
              control={
                <ToggleGroup
                  type="multiple"
                  variant="outline"
                  size="sm"
                  spacing={1}
                  className="max-w-[360px] flex-wrap justify-end"
                  aria-label={name}
                  value={picksByProvider[p.provider] ?? []}
                  onValueChange={(keys) =>
                    setPicks(p.provider, normalizeStatusBarUsageWindowKeys(keys))
                  }
                >
                  {options.map((option) => (
                    <ToggleGroupItem key={option.key} value={option.key}>
                      {formatPickedUsageName(option)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              }
            />
          )
        })
      )}
    </div>
  )
}
