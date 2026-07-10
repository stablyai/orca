import type React from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type ExperimentalEditorInputSettingProps = {
  settings: Pick<GlobalSettings, 'editorExperimentalInput'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function ExperimentalEditorInputSetting({
  settings,
  updateSettings
}: ExperimentalEditorInputSettingProps): React.JSX.Element {
  const enabled = settings.editorExperimentalInput ?? false

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.GeneralEditorSettingsSection.30baaa4a0f',
        'Experimental Editor Input'
      )}
      description={translate(
        'auto.components.settings.GeneralEditorSettingsSection.f5663213a9',
        'Use a newer text-input engine (EditContext) for editors. If typing ever stops working, turn this off to use the classic input path, which is more reliable.'
      )}
      keywords={['editcontext', 'input', 'typing', 'ime', 'keyboard', 'experimental']}
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.GeneralEditorSettingsSection.30baaa4a0f',
          'Experimental Editor Input'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.f5663213a9',
          'Use a newer text-input engine (EditContext) for editors. If typing ever stops working, turn this off to use the classic input path, which is more reliable.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ editorExperimentalInput: !enabled })}
      />
    </SearchableSetting>
  )
}
