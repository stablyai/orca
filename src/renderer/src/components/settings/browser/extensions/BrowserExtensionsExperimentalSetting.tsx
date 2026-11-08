import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '../../../ui/label'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsSwitch } from '../../form-controls/SettingsFormControls'
import { getExperimentalSearchEntry } from '../../advanced/experimental-search'

type BrowserExtensionsExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserExtensionsExperimentalSetting({
  settings,
  updateSettings
}: BrowserExtensionsExperimentalSettingProps): React.JSX.Element {
  const t = useTranslate()
  const entry = getExperimentalSearchEntry(t).browserExtensions
  const enabled = settings.experimentalBrowserExtensions === true

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-3 py-3"
      id="experimental-browser-extensions"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.ExperimentalPane.browserExtensions.copy',
              'Adds Settings › Browser › Extensions for local browser profiles.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={t(
            'auto.components.settings.ExperimentalPane.browserExtensions.toggleLabel',
            'Toggle browser extensions'
          )}
          onChange={() => updateSettings({ experimentalBrowserExtensions: !enabled })}
        />
      </div>
    </SearchableSetting>
  )
}
