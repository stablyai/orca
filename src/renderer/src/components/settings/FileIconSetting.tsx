import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { getFileIconEntries } from './file-icon-search'

export function FileIconSetting({
  settings,
  updateSettings,
  forceVisible
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}): React.JSX.Element {
  const entry = getFileIconEntries()[0]
  return (
    <SearchableSetting {...entry} forceVisible={forceVisible}>
      <SettingsRow
        label={entry.title}
        control={
          <SettingsSegmentedControl
            ariaLabel={entry.title}
            value={settings.coloredFileIcons === true ? 'colored' : 'monochrome'}
            onChange={(value) => updateSettings({ coloredFileIcons: value === 'colored' })}
            options={[
              {
                value: 'monochrome',
                label: translate('settings.appearance.fileIcons.monochrome', 'Monochrome')
              },
              {
                value: 'colored',
                label: translate('settings.appearance.fileIcons.colored', 'Colored')
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
