import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from './SettingsFormControls'

type EditorCenteredLayoutSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorCenteredLayoutSetting({
  settings,
  updateSettings
}: EditorCenteredLayoutSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.EditorCenteredLayoutSetting.title',
        'Centered Layout'
      )}
      description={translate(
        'auto.components.settings.EditorCenteredLayoutSetting.description',
        'Center the file editor in a readable column on wide panes, like VS Code.'
      )}
      keywords={[
        'editor',
        'centered layout',
        'center editor',
        'max width',
        'ultrawide',
        'readable'
      ]}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>
          {translate(
            'auto.components.settings.EditorCenteredLayoutSetting.title',
            'Centered Layout'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.EditorCenteredLayoutSetting.description',
            'Center the file editor in a readable column on wide panes, like VS Code.'
          )}
        </p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={translate(
          'auto.components.settings.EditorCenteredLayoutSetting.title',
          'Centered Layout'
        )}
        value={settings.editorCenteredLayout === true ? 'on' : 'off'}
        onChange={(option) => updateSettings({ editorCenteredLayout: option === 'on' })}
        options={[
          {
            value: 'off',
            label: translate(
              'auto.components.settings.GeneralEditorSettingsSection.bf16ef0af2',
              'Off'
            )
          },
          {
            value: 'on',
            label: translate(
              'auto.components.settings.GeneralEditorSettingsSection.3f6892f307',
              'On'
            )
          }
        ]}
      />
    </SearchableSetting>
  )
}
