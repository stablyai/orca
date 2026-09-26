import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow } from './SettingsFormControls'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import {
  DARK_EDITOR_THEMES,
  DEFAULT_EDITOR_THEME_DARK,
  DEFAULT_EDITOR_THEME_LIGHT,
  LIGHT_EDITOR_THEMES
} from '@/lib/monaco-themes'

type EditorThemeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/**
 * Settings row controls for configuring Monaco editor themes in dark and light modes.
 */
export function EditorThemeSetting({
  settings,
  updateSettings
}: EditorThemeSettingProps): React.JSX.Element {
  const darkThemeTitle = translate(
    'auto.components.settings.EditorThemeSetting.darkTitle',
    'Editor Theme (Dark Mode)'
  )
  const darkThemeDescription = translate(
    'auto.components.settings.EditorThemeSetting.darkDescription',
    'Theme used by file editors and diff viewers when Orca is in dark mode.'
  )

  const lightThemeTitle = translate(
    'auto.components.settings.EditorThemeSetting.lightTitle',
    'Editor Theme (Light Mode)'
  )
  const lightThemeDescription = translate(
    'auto.components.settings.EditorThemeSetting.lightDescription',
    'Theme used by file editors and diff viewers when Orca is in light mode.'
  )

  return (
    <>
      <SearchableSetting
        title={darkThemeTitle}
        description={darkThemeDescription}
        keywords={[
          'editor',
          'theme',
          'dark',
          'monaco',
          'syntax',
          'dracula',
          'one dark',
          'nord',
          'tokyo night',
          'catppuccin',
          'diff'
        ]}
      >
        <SettingsRow
          label={darkThemeTitle}
          description={darkThemeDescription}
          control={
            <Select
              value={settings.editorThemeDark ?? DEFAULT_EDITOR_THEME_DARK}
              onValueChange={(value) => updateSettings({ editorThemeDark: value })}
            >
              <SelectTrigger className="w-[200px]" aria-label={darkThemeTitle}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DARK_EDITOR_THEMES.map((theme) => (
                  <SelectItem key={theme.id} value={theme.id}>
                    {theme.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SearchableSetting>

      <SearchableSetting
        title={lightThemeTitle}
        description={lightThemeDescription}
        keywords={[
          'editor',
          'theme',
          'light',
          'monaco',
          'syntax',
          'diff',
          'one light',
          'catppuccin'
        ]}
      >
        <SettingsRow
          label={lightThemeTitle}
          description={lightThemeDescription}
          control={
            <Select
              value={settings.editorThemeLight ?? DEFAULT_EDITOR_THEME_LIGHT}
              onValueChange={(value) => updateSettings({ editorThemeLight: value })}
            >
              <SelectTrigger className="w-[200px]" aria-label={lightThemeTitle}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIGHT_EDITOR_THEMES.map((theme) => (
                  <SelectItem key={theme.id} value={theme.id}>
                    {theme.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SearchableSetting>
    </>
  )
}
