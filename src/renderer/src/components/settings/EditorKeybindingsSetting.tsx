import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveEditorKeybindings } from '../../../../shared/editor-keybindings'
import type { EditorKeybindingsPreset } from '../../../../shared/editor-keybindings'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from './SettingsFormControls'

type EditorKeybindingsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorKeybindingsSetting({
  settings,
  updateSettings
}: EditorKeybindingsSettingProps): React.JSX.Element {
  const title = translate(
    'auto.components.settings.EditorKeybindingsSetting.title',
    'Editor Keybindings'
  )
  return (
    <SearchableSetting
      title={title}
      description={translate(
        'auto.components.settings.EditorKeybindingsSetting.description',
        'Use Vim motions in writable file editors. Default keeps the current editor keys.'
      )}
      keywords={['editor', 'keybindings', 'keymap', 'vim', 'modal', 'normal mode']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.EditorKeybindingsSetting.description',
            'Use Vim motions in writable file editors. Default keeps the current editor keys.'
          )}
        </p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={title}
        value={resolveEditorKeybindings(settings.editorKeybindings)}
        onChange={(option: EditorKeybindingsPreset) =>
          updateSettings({ editorKeybindings: option })
        }
        options={[
          {
            value: 'default',
            label: translate('auto.components.settings.EditorKeybindingsSetting.default', 'Default')
          },
          {
            value: 'vim',
            label: translate('auto.components.settings.EditorKeybindingsSetting.vim', 'Vim')
          }
        ]}
      />
    </SearchableSetting>
  )
}
