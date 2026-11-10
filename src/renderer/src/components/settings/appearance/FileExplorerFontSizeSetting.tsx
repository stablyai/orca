import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  FILE_EXPLORER_DEFAULT_FONT_SIZE,
  FILE_EXPLORER_FONT_SIZE_MAX,
  FILE_EXPLORER_FONT_SIZE_MIN
} from '@/lib/file-explorer-font-size'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { NumberField } from '../form-controls/SettingsFormControls'
import { getFileExplorerFontSizeEntry } from './appearance-search'

export function FileExplorerFontSizeSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getFileExplorerFontSizeEntry(t)
  return (
    <SearchableSetting {...entry}>
      <NumberField
        label={entry.title}
        description={entry.description}
        value={settings.fileExplorerFontSize}
        min={FILE_EXPLORER_FONT_SIZE_MIN}
        max={FILE_EXPLORER_FONT_SIZE_MAX}
        integer
        placeholder={String(FILE_EXPLORER_DEFAULT_FONT_SIZE)}
        suffix={t('auto.components.settings.editorTypography.fontSizeUnit', 'px')}
        onChange={(value) => updateSettings({ fileExplorerFontSize: value })}
        onClear={() => updateSettings({ fileExplorerFontSize: undefined })}
      />
    </SearchableSetting>
  )
}
