import type React from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { FontAutocomplete, SettingsRow } from './SettingsFormControls'

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
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.EditorFontFamilySetting.title',
        'Editor Font Family'
      )}
      description={translate(
        'auto.components.settings.EditorFontFamilySetting.description',
        'Font used by file editors and diff views. Leave empty to follow the terminal font.'
      )}
      keywords={['editor', 'font', 'typography', 'family', 'code', 'cjk']}
    >
      <SettingsRow
        label={translate(
          'auto.components.settings.EditorFontFamilySetting.title',
          'Editor Font Family'
        )}
        description={translate(
          'auto.components.settings.EditorFontFamilySetting.description',
          'Font used by file editors and diff views. Leave empty to follow the terminal font.'
        )}
        control={
          <FontAutocomplete
            value={settings.editorFontFamily ?? ''}
            suggestions={fontSuggestions}
            onRequestSuggestions={onRequestFontSuggestions}
            placeholder={translate(
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
