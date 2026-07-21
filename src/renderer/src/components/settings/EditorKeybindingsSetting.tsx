import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type EditorKeybindingsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Settings control that selects the file editor's keybinding preset (Default or Vim). */
export function EditorKeybindingsSetting({
  settings,
  updateSettings
}: EditorKeybindingsSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.EditorKeybindingsSetting.78648745bc',
        'Editor Keybindings'
      )}
      description={translate(
        'auto.components.settings.EditorKeybindingsSetting.a30ca600ee',
        'Use Vim modal keybindings in the code editor instead of standard editing.'
      )}
      keywords={['editor', 'code', 'vim', 'keybindings', 'keymap', 'modal', 'motions']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>
          {translate(
            'auto.components.settings.EditorKeybindingsSetting.78648745bc',
            'Editor Keybindings'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.EditorKeybindingsSetting.a30ca600ee',
            'Use Vim modal keybindings in the code editor instead of standard editing.'
          )}
        </p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={translate(
          'auto.components.settings.EditorKeybindingsSetting.78648745bc',
          'Editor Keybindings'
        )}
        value={settings.editorKeybindings === 'vim' ? 'vim' : 'default'}
        onChange={(option) =>
          updateSettings({ editorKeybindings: option === 'vim' ? 'vim' : 'default' })
        }
        options={[
          {
            value: 'default',
            label: translate(
              'auto.components.settings.EditorKeybindingsSetting.1b23c01cc6',
              'Default'
            )
          },
          {
            value: 'vim',
            label: translate('auto.components.settings.EditorKeybindingsSetting.77674e2d1e', 'Vim')
          }
        ]}
      />
    </SearchableSetting>
  )
}
