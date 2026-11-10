import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { FontAutocomplete } from '../appearance/fonts/FontAutocomplete'
import { SettingsRow } from '../form-controls/SettingsFormControls'

type EditorFontFamilySettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  fontSuggestions: string[]
  onRequestFontSuggestions?: () => void
}

export function EditorFontFamilySetting({
  settings,
  updateSettings,
  fontSuggestions,
  onRequestFontSuggestions
}: EditorFontFamilySettingProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <SearchableSetting
      id={GENERAL_SETTING_ANCHORS.fontFamily}
      title={t('auto.components.settings.EditorFontFamilySetting.458ec82128', 'Editor font family')}
      description={t(
        'auto.components.settings.EditorFontFamilySetting.description',
        'Font used by file editors and diff views, and by Markdown code when set. Leave empty to follow the terminal font.'
      )}
      keywords={['editor', 'font', 'typography', 'family', 'code', 'cjk']}
    >
      <SettingsRow
        label={t(
          'auto.components.settings.EditorFontFamilySetting.458ec82128',
          'Editor font family'
        )}
        description={t(
          'auto.components.settings.EditorFontFamilySetting.description',
          'Font used by file editors and diff views, and by Markdown code when set. Leave empty to follow the terminal font.'
        )}
        control={
          <FontAutocomplete
            value={settings.editorFontFamily ?? ''}
            suggestions={fontSuggestions}
            onRequestSuggestions={onRequestFontSuggestions}
            placeholder={t(
              'auto.components.settings.EditorFontFamilySetting.placeholder',
              'Same as terminal font'
            )}
            onChange={(value) => updateSettings({ editorFontFamily: value })}
          />
        }
      />
    </SearchableSetting>
  )
}
