import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from './SettingsFormControls'

type EditorLineNumbersSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorLineNumbersSetting({
  settings,
  updateSettings
}: EditorLineNumbersSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.GeneralEditorSettingsSection.editorLineNumbersTitle',
        'Editor Line Numbers'
      )}
      description={translate(
        'auto.components.settings.GeneralEditorSettingsSection.editorLineNumbersDescription',
        'Show line numbers in code, text, and diff editors.'
      )}
      keywords={['editor', 'code', 'line numbers', 'gutter', 'diff']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>
          {translate(
            'auto.components.settings.GeneralEditorSettingsSection.editorLineNumbersTitle',
            'Editor Line Numbers'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.GeneralEditorSettingsSection.editorLineNumbersDescription',
            'Show line numbers in code, text, and diff editors.'
          )}
        </p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={translate(
          'auto.components.settings.GeneralEditorSettingsSection.editorLineNumbersTitle',
          'Editor Line Numbers'
        )}
        value={settings.editorLineNumbers === false ? 'off' : 'on'}
        onChange={(option) => updateSettings({ editorLineNumbers: option === 'on' })}
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
