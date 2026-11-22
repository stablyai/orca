import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'

export function usePasteThumbnailAppearanceEntry() {
  const t = useTranslate()
  return {
    title: t('settings.appearance.pasteThumbnail.title', 'Show clipboard image previews'),
    description: t(
      'settings.appearance.pasteThumbnail.description',
      'Sample a small image preview when you hover over Paste in the file explorer.'
    )
  }
}

export function PasteThumbnailAppearanceSetting({
  entry,
  settings,
  updateSettings
}: {
  entry: ReturnType<typeof usePasteThumbnailAppearanceEntry>
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  return (
    <SearchableSetting {...entry}>
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={settings.fileExplorerPasteThumbnailEnabled !== false}
        onChange={() =>
          updateSettings({
            fileExplorerPasteThumbnailEnabled: settings.fileExplorerPasteThumbnailEnabled === false
          })
        }
      />
    </SearchableSetting>
  )
}
