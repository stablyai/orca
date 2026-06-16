import type React from 'react'
import { Timer } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { getGeneralCacheTimerSearchEntries } from './general-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitch } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type GeneralCacheTimerSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function GeneralCacheTimerSection({
  settings,
  updateSettings
}: GeneralCacheTimerSectionProps): React.JSX.Element {
  return (
    <section key="cache-timer" className="space-y-4">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.GeneralCacheTimerSection.a137f8854d',
          'Prompt Cache Timer'
        )}
        description={translate(
          'auto.components.settings.GeneralCacheTimerSection.fe590653c1',
          'Claude caches your conversation to reduce costs. When idle too long the cache expires and the next message resends full context at higher cost. This shows a countdown so you know when to resume.'
        )}
      />

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralCacheTimerSection.b4e7302944',
          'Cache Timer'
        )}
        description={translate(
          'auto.components.settings.GeneralCacheTimerSection.9c20253679',
          'Show a countdown after a Claude agent becomes idle.'
        )}
        keywords={getGeneralCacheTimerSearchEntries().flatMap((entry) => [
          entry.title,
          entry.description ?? '',
          ...(entry.keywords ?? [])
        ])}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <Timer className="size-4 text-muted-foreground" />
            <Label>
              {translate(
                'auto.components.settings.GeneralCacheTimerSection.b4e7302944',
                'Cache Timer'
              )}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.GeneralCacheTimerSection.487b176240',
              'Show a countdown in the sidebar after a Claude agent becomes idle.'
            )}
          </p>
        </div>
        <SettingsSwitch
          ariaLabel={translate(
            'auto.components.settings.GeneralCacheTimerSection.b4e7302944',
            'Cache Timer'
          )}
          checked={settings.promptCacheTimerEnabled}
          onChange={() => {
            const enabling = !settings.promptCacheTimerEnabled
            updateSettings({ promptCacheTimerEnabled: enabling })
            if (enabling) {
              useAppStore.getState().seedCacheTimersForIdleTabs()
            }
          }}
        />
      </SearchableSetting>

      {settings.promptCacheTimerEnabled && (
        <SearchableSetting
          title={translate(
            'auto.components.settings.GeneralCacheTimerSection.a2a8962138',
            'Timer Duration'
          )}
          description={translate(
            'auto.components.settings.GeneralCacheTimerSection.80c454e8a6',
            "Match this to your provider's cache TTL."
          )}
          keywords={['cache', 'timer', 'duration', 'ttl']}
          className="flex items-center justify-between gap-4 py-2 pl-7"
        >
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label>
              {translate(
                'auto.components.settings.GeneralCacheTimerSection.a2a8962138',
                'Timer Duration'
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.GeneralCacheTimerSection.8b9e202e0a',
                "Match this to your provider's cache TTL. The default is 5 minutes."
              )}
            </p>
          </div>
          <Select
            value={String(settings.promptCacheTtlMs)}
            onValueChange={(v) => updateSettings({ promptCacheTtlMs: Number(v) })}
          >
            <SelectTrigger size="sm" className="h-7 text-xs w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="300000">
                {translate(
                  'auto.components.settings.GeneralCacheTimerSection.54395ecd7c',
                  '5 minutes'
                )}
              </SelectItem>
              <SelectItem value="3600000">
                {translate(
                  'auto.components.settings.GeneralCacheTimerSection.05de84a104',
                  '1 hour'
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        </SearchableSetting>
      )}
    </section>
  )
}
