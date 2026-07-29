import type React from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type RichMarkdownSpellcheckSettingProps = {
  settings: Pick<GlobalSettings, 'richMarkdownSpellcheckEnabled'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function RichMarkdownSpellcheckSetting({
  settings,
  updateSettings
}: RichMarkdownSpellcheckSettingProps): React.JSX.Element {
  const enabled = settings.richMarkdownSpellcheckEnabled ?? true

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.GeneralEditorSettingsSection.b82f86d7d2',
        'Rich Markdown Spellcheck'
      )}
      description={translate(
        'auto.components.settings.GeneralEditorSettingsSection.5195f0b9ef',
        'Show browser spelling underlines and suggestions while editing rich Markdown.'
      )}
      keywords={['spellcheck', 'spell check', 'spelling', 'markdown', 'red underline']}
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.GeneralEditorSettingsSection.b82f86d7d2',
          'Rich Markdown Spellcheck'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.5195f0b9ef',
          'Show browser spelling underlines and suggestions while editing rich Markdown.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ richMarkdownSpellcheckEnabled: !enabled })}
      />
    </SearchableSetting>
  )
}
