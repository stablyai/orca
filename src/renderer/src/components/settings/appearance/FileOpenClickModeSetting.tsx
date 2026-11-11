import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { getFileOpenClickModeEntry } from './appearance-file-open-search'

export function FileOpenClickModeSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getFileOpenClickModeEntry(t)

  return (
    <SearchableSetting {...entry}>
      <SettingsRow
        label={entry.title}
        description={entry.description}
        control={
          <SettingsSegmentedControl<'single' | 'double'>
            ariaLabel={entry.title}
            value={settings.fileOpenClickMode ?? 'single'}
            onChange={(fileOpenClickMode) => updateSettings({ fileOpenClickMode })}
            options={[
              { value: 'single', label: t('settings.fileOpenClickMode.single', 'Single click') },
              { value: 'double', label: t('settings.fileOpenClickMode.double', 'Double click') }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
