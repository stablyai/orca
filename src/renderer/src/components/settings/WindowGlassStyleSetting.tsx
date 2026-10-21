import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'
import { getWindowGlassStyleSearchEntry } from './window-glass-search'

type Props = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function WindowGlassStyleSetting({ settings, updateSettings }: Props): React.JSX.Element {
  const entry = getWindowGlassStyleSearchEntry()
  return (
    <SearchableSetting {...entry}>
      <SettingsRow
        label={entry.title}
        description={entry.description}
        control={
          <SettingsSegmentedControl
            ariaLabel={entry.title}
            value={settings.windowGlassStyle ?? 'frosted'}
            onChange={(windowGlassStyle) => updateSettings({ windowGlassStyle })}
            options={[
              { value: 'frosted', label: translate('settings.windowGlass.frosted', 'Frosted') },
              {
                value: 'liquid',
                label: translate('settings.windowGlass.liquid', 'Liquid Glass style')
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
