import type React from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { EDITOR_COLOR_THEME_VALUES, type EditorColorThemeValue } from '@/lib/editor-theme'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from './SettingsFormControls'

type EditorColorThemeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Human-readable labels for the options — kept separate from the resolver
 *  module's option list so `translate()` calls stay in a renderer component. */
function optionLabel(value: EditorColorThemeValue): string {
  switch (value) {
    case 'auto':
      return translate('auto.components.settings.EditorColorThemeSetting.auto', 'Follow app theme')
    case 'vs':
      return translate('auto.components.settings.EditorColorThemeSetting.vs', 'Light')
    case 'vs-dark':
      return translate('auto.components.settings.EditorColorThemeSetting.vsDark', 'Dark')
    case 'monokai':
      return translate('auto.components.settings.EditorColorThemeSetting.monokai', 'Monokai')
  }
}

export function EditorColorThemeSetting({
  settings,
  updateSettings
}: EditorColorThemeSettingProps): React.JSX.Element {
  const value = settings.editorColorTheme ?? 'auto'

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.EditorColorThemeSetting.title',
        'Editor Color Theme'
      )}
      description={translate(
        'auto.components.settings.EditorColorThemeSetting.description',
        'Syntax highlighting theme used by file editors and diff views. "Follow app theme" switches between the default light and dark themes.'
      )}
      keywords={['editor', 'theme', 'color', 'syntax', 'highlighting', 'monokai', 'dark', 'light']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>
          {translate(
            'auto.components.settings.EditorColorThemeSetting.title',
            'Editor Color Theme'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.EditorColorThemeSetting.description',
            'Syntax highlighting theme used by file editors and diff views. "Follow app theme" switches between the default light and dark themes.'
          )}
        </p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={translate(
          'auto.components.settings.EditorColorThemeSetting.title',
          'Editor Color Theme'
        )}
        value={value}
        onChange={(option) => updateSettings({ editorColorTheme: option })}
        options={EDITOR_COLOR_THEME_VALUES.map((value) => ({
          value,
          label: optionLabel(value)
        }))}
      />
    </SearchableSetting>
  )
}
