import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { isEditorKeybindingsPreset } from '../../../../../shared/editor-keybindings-preset'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { Label } from '../../ui/label'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'

export function getEditorKeybindingsSearchEntry(t: Translate = translate) {
  return {
    title: t('settings.editorKeybindings.title', 'Editor Keybindings'),
    description: t(
      'settings.editorKeybindings.description',
      'Use Emacs keybindings in the code editor instead of standard editing.'
    ),
    keywords: [t('settings.editorKeybindings.keywords', 'editor keybindings keymap emacs')]
  }
}

export function EditorKeybindingsSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getEditorKeybindingsSearchEntry(t)
  const preset = isEditorKeybindingsPreset(settings.editorKeybindings)
    ? settings.editorKeybindings
    : 'default'
  return (
    <SearchableSetting {...entry} className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{entry.title}</Label>
        <p className="text-xs text-muted-foreground">{entry.description}</p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={entry.title}
        value={preset}
        onChange={(option) => updateSettings({ editorKeybindings: option })}
        options={[
          { value: 'default', label: t('settings.editorKeybindings.default', 'Default') },
          { value: 'emacs', label: t('settings.editorKeybindings.emacs', 'Emacs') }
        ]}
      />
    </SearchableSetting>
  )
}
