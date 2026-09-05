import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type EditorChangedLineHighlightsSettingProps = {
  settings: Pick<GlobalSettings, 'editorChangedLineHighlightsEnabled'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorChangedLineHighlightsSetting({
  settings,
  updateSettings
}: EditorChangedLineHighlightsSettingProps): React.JSX.Element {
  const enabled = settings.editorChangedLineHighlightsEnabled ?? true

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.EditorChangedLineHighlightsSetting.67d39a5ae2',
        'Changed Line Highlights'
      )}
      description={translate(
        'auto.components.settings.EditorChangedLineHighlightsSetting.24b4de517a',
        'Tint lines that differ from the git baseline while editing a tracked file.'
      )}
      keywords={['changed lines', 'git', 'diff', 'gutter', 'highlight']}
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.EditorChangedLineHighlightsSetting.67d39a5ae2',
          'Changed Line Highlights'
        )}
        description={translate(
          'auto.components.settings.EditorChangedLineHighlightsSetting.24b4de517a',
          'Tint lines that differ from the git baseline while editing a tracked file.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ editorChangedLineHighlightsEnabled: !enabled })}
      />
    </SearchableSetting>
  )
}
