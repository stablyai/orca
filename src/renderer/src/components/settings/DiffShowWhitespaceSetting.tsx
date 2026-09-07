import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from './SettingsFormControls'

type DiffShowWhitespaceSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function DiffShowWhitespaceSetting({
  settings,
  updateSettings
}: DiffShowWhitespaceSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.GeneralEditorSettingsSection.f1b3ceeb98',
        'Diff Show Whitespace'
      )}
      description={translate(
        'auto.components.settings.GeneralEditorSettingsSection.94a479cef3',
        'Show leading and trailing whitespace differences in diffs.'
      )}
      keywords={['diff', 'whitespace', 'spaces', 'tabs', 'trim', 'indentation']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>
          {translate(
            'auto.components.settings.GeneralEditorSettingsSection.f1b3ceeb98',
            'Diff Show Whitespace'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.GeneralEditorSettingsSection.94a479cef3',
            'Show leading and trailing whitespace differences in diffs.'
          )}
        </p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={translate(
          'auto.components.settings.GeneralEditorSettingsSection.f1b3ceeb98',
          'Diff Show Whitespace'
        )}
        value={settings.diffShowWhitespace ? 'on' : 'off'}
        onChange={(option) => updateSettings({ diffShowWhitespace: option === 'on' })}
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
