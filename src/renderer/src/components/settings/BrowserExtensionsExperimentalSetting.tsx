import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getExperimentalSearchEntry } from './experimental-search'

type BrowserExtensionsExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserExtensionsExperimentalSetting({
  settings,
  updateSettings
}: BrowserExtensionsExperimentalSettingProps): React.JSX.Element {
  const entry = getExperimentalSearchEntry().browserExtensions
  const enabled = settings.experimentalBrowserExtensions === true

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-3 py-2"
      id="experimental-browser-extensions"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.browserExtensions.copy',
              'Adds Settings › Browser › Extensions for local browser profiles.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.browserExtensions.toggleLabel',
            'Toggle browser extensions'
          )}
          onChange={() => updateSettings({ experimentalBrowserExtensions: !enabled })}
        />
      </div>
    </SearchableSetting>
  )
}
