import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isEditorKeybindingsPreset } from '../../../../shared/editor-keybindings-preset'
import { SearchableSetting } from './SearchableSetting'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type EditorKeybindingsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Settings control that selects the file editor's keybinding preset (Default, Vim or Emacs). */
export function EditorKeybindingsSetting({
  settings,
  updateSettings
}: EditorKeybindingsSettingProps): React.JSX.Element {
  // Why: profiles saved before the preset existed, or with a retired preset, must still render.
  const preset = isEditorKeybindingsPreset(settings.editorKeybindings)
    ? settings.editorKeybindings
    : 'default'
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.EditorKeybindingsSetting.78648745bc',
        'Editor Keybindings'
      )}
      description={translate(
        'auto.components.settings.EditorKeybindingsSetting.4f1e9c2a7d',
        'Use Vim modal or Emacs keybindings in the code editor instead of standard editing.'
      )}
      keywords={['editor', 'code', 'vim', 'emacs', 'keybindings', 'keymap', 'modal', 'motions']}
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
            'auto.components.settings.EditorKeybindingsSetting.4f1e9c2a7d',
            'Use Vim modal or Emacs keybindings in the code editor instead of standard editing.'
          )}
        </p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={translate(
          'auto.components.settings.EditorKeybindingsSetting.78648745bc',
          'Editor Keybindings'
        )}
        value={preset}
        onChange={(option) => updateSettings({ editorKeybindings: option })}
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
          },
          {
            value: 'emacs',
            label: translate(
              'auto.components.settings.EditorKeybindingsSetting.8b3d6e0f2c',
              'Emacs'
            )
          }
        ]}
      />
    </SearchableSetting>
  )
}
