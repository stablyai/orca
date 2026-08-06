import type React from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow } from './SettingsFormControls'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

type EditorThemePreference = NonNullable<GlobalSettings['editorTheme']>

type EditorThemeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorThemeSetting({
  settings,
  updateSettings
}: EditorThemeSettingProps): React.JSX.Element {
  const options: { value: EditorThemePreference; label: string }[] = [
    {
      value: 'app',
      label: translate('auto.components.settings.EditorThemeSetting.0fe1885fc8', 'Follow app')
    },
    {
      value: 'light',
      label: translate('auto.components.settings.EditorThemeSetting.b440871212', 'Light')
    },
    {
      value: 'dark',
      label: translate('auto.components.settings.EditorThemeSetting.2f2077c751', 'Dark')
    },
    {
      value: 'high-contrast-light',
      label: translate(
        'auto.components.settings.EditorThemeSetting.c926ce36fe',
        'High Contrast Light'
      )
    },
    {
      value: 'high-contrast-dark',
      label: translate(
        'auto.components.settings.EditorThemeSetting.50fda83310',
        'High Contrast Dark'
      )
    },
    {
      value: 'dracula',
      label: translate('auto.components.settings.EditorThemeSetting.079325a73f', 'Dracula')
    }
  ]

  const title = translate('auto.components.settings.EditorThemeSetting.1fdb8f6275', 'Editor Theme')
  const description = translate(
    'auto.components.settings.EditorThemeSetting.80410e712b',
    'Choose a color theme for file, diff, and notebook code editors.'
  )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['editor', 'theme', 'colors', 'syntax', 'monaco', 'dracula']}
    >
      <SettingsRow
        label={title}
        description={description}
        control={
          <Select
            value={settings.editorTheme ?? 'app'}
            onValueChange={(value) =>
              updateSettings({ editorTheme: value as EditorThemePreference })
            }
          >
            <SelectTrigger className="w-48" aria-label={title}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}
