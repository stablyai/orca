import type React from 'react'
import { Timer } from 'lucide-react'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { useAppStore } from '../../../../store/index'
import { Label } from '../../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { getAgentCacheTimerSearchEntries } from './agent-cache-timer-search'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsSwitch } from '../../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

type AgentCacheTimerSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function AgentCacheTimerSection({
  settings,
  updateSettings
}: AgentCacheTimerSectionProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsGroup
      title={t('auto.components.settings.AgentCacheTimerSection.a137f8854d', 'Prompt Cache Timer')}
      description={t(
        'auto.components.settings.AgentCacheTimerSection.fe590653c1',
        'Claude caches your conversation to reduce costs. When idle too long the cache expires and the next message resends full context at higher cost. This shows a countdown so you know when to resume.'
      )}
    >
      <SearchableSetting
        title={t('auto.components.settings.AgentCacheTimerSection.b4e7302944', 'Cache Timer')}
        description={t(
          'auto.components.settings.AgentCacheTimerSection.9c20253679',
          'Show a countdown after a Claude agent becomes idle.'
        )}
        keywords={getAgentCacheTimerSearchEntries().flatMap((entry) => [
          entry.title,
          entry.description ?? '',
          ...(entry.keywords ?? [])
        ])}
        className="flex items-center justify-between gap-4 py-3"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <Timer className="size-4 text-muted-foreground" />
            <Label>
              {t('auto.components.settings.AgentCacheTimerSection.b4e7302944', 'Cache Timer')}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.AgentCacheTimerSection.487b176240',
              'Show a countdown in the sidebar after a Claude agent becomes idle.'
            )}
          </p>
        </div>
        <SettingsSwitch
          ariaLabel={t('auto.components.settings.AgentCacheTimerSection.b4e7302944', 'Cache Timer')}
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
          title={t('auto.components.settings.AgentCacheTimerSection.a2a8962138', 'Timer Duration')}
          description={t(
            'auto.components.settings.AgentCacheTimerSection.80c454e8a6',
            "Match this to your provider's cache TTL."
          )}
          keywords={['cache', 'timer', 'duration', 'ttl']}
          className="flex items-center justify-between gap-4 py-3 pl-7"
        >
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label>
              {t('auto.components.settings.AgentCacheTimerSection.a2a8962138', 'Timer Duration')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                'auto.components.settings.AgentCacheTimerSection.8b9e202e0a',
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
                {t('auto.components.settings.AgentCacheTimerSection.54395ecd7c', '5 minutes')}
              </SelectItem>
              <SelectItem value="3600000">
                {t('auto.components.settings.AgentCacheTimerSection.05de84a104', '1 hour')}
              </SelectItem>
            </SelectContent>
          </Select>
        </SearchableSetting>
      )}
    </SettingsGroup>
  )
}
