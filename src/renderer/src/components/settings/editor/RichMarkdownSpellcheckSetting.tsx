import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'

type RichMarkdownSpellcheckSettingProps = {
  settings: Pick<GlobalSettings, 'richMarkdownSpellcheckEnabled'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function RichMarkdownSpellcheckSetting({
  settings,
  updateSettings
}: RichMarkdownSpellcheckSettingProps): React.JSX.Element {
  const t = useTranslate()
  const enabled = settings.richMarkdownSpellcheckEnabled ?? true

  return (
    <SearchableSetting
      id={GENERAL_SETTING_ANCHORS.spellcheck}
      title={t(
        'auto.components.settings.GeneralEditorSettingsSection.a0361dfb05',
        'Rich Markdown spellcheck'
      )}
      description={t(
        'auto.components.settings.GeneralEditorSettingsSection.5195f0b9ef',
        'Show browser spelling underlines and suggestions while editing rich Markdown.'
      )}
      keywords={['spellcheck', 'spell check', 'spelling', 'markdown', 'red underline']}
    >
      <SettingsSwitchRow
        label={t(
          'auto.components.settings.GeneralEditorSettingsSection.a0361dfb05',
          'Rich Markdown spellcheck'
        )}
        description={t(
          'auto.components.settings.GeneralEditorSettingsSection.5195f0b9ef',
          'Show browser spelling underlines and suggestions while editing rich Markdown.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ richMarkdownSpellcheckEnabled: !enabled })}
      />
    </SearchableSetting>
  )
}
