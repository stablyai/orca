import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  MAX_BROWSER_MEMORY_SAVER_HOURS,
  MIN_BROWSER_MEMORY_SAVER_HOURS,
  getEffectiveBrowserMemorySaverHours
} from '../../../../../shared/browser/guest-lifecycle/browser-memory-saver'
import { NumberField, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroupNestedRows } from '../section-layout/SettingsGroup'
import { useTranslate } from '@/i18n/use-translate'
import { getBrowserMemorySaverSearchEntry } from './browser-memory-saver-search'

type BrowserMemorySaverSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserMemorySaverSetting({
  settings,
  updateSettings
}: BrowserMemorySaverSettingProps): React.JSX.Element {
  const t = useTranslate()
  const entry = getBrowserMemorySaverSearchEntry()
  // The switch keeps its original kill-switch key so existing opt-outs carry over.
  const enabled = settings.browserGuestWorktreeRetentionBudget !== false

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      id="browser-memory-saver"
    >
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={enabled}
        onChange={() => updateSettings({ browserGuestWorktreeRetentionBudget: !enabled })}
      />
      {enabled ? (
        <SettingsGroupNestedRows>
          <NumberField
            label={t('settings.browser.memorySaver.unviewedForLabel', 'Unviewed for')}
            description={t(
              'settings.browser.memorySaver.unviewedForDescription',
              "How long a tab goes unviewed before it's freed."
            )}
            value={getEffectiveBrowserMemorySaverHours(settings.browserMemorySaverHours)}
            min={MIN_BROWSER_MEMORY_SAVER_HOURS}
            max={MAX_BROWSER_MEMORY_SAVER_HOURS}
            step={1}
            integer
            suffix={t('settings.browser.memorySaver.hoursSuffix', 'hours')}
            onChange={(hours) => updateSettings({ browserMemorySaverHours: hours })}
          />
        </SettingsGroupNestedRows>
      ) : null}
    </SearchableSetting>
  )
}
