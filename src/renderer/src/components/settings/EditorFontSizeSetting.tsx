import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { NumberField } from './SettingsFormControls'
import { getEditorFontSizeSearchEntry } from './general-editor-search'

// Same bounds as the terminal font size; editor zoom still clamps to 8-32 on top.
const MIN_EDITOR_FONT_SIZE = 10
const MAX_EDITOR_FONT_SIZE = 24

type EditorFontSizeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorFontSizeSetting({
  settings,
  updateSettings
}: EditorFontSizeSettingProps): React.JSX.Element {
  const entry = getEditorFontSizeSearchEntry()

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      <NumberField
        label={entry.title}
        description={entry.description}
        value={settings.editorFontSize}
        min={MIN_EDITOR_FONT_SIZE}
        max={MAX_EDITOR_FONT_SIZE}
        integer
        // The placeholder shows the terminal size an empty field follows.
        placeholder={String(settings.terminalFontSize)}
        suffix={translate('auto.components.settings.EditorFontSizeSetting.px', 'px')}
        onChange={(value) => updateSettings({ editorFontSize: value })}
        onClear={() => updateSettings({ editorFontSize: undefined })}
      />
    </SearchableSetting>
  )
}
