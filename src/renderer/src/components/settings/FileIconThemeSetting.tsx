import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { usePluginIconThemes } from '@/store/plugin-icon-themes'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

const BUILTIN_ICON_THEME_ID = 'builtin'

type FileIconThemeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  ariaLabel: string
}

export function FileIconThemeSetting({
  settings,
  updateSettings,
  ariaLabel
}: FileIconThemeSettingProps): React.JSX.Element {
  const themes = usePluginIconThemes()
  const selected = themes.some((theme) => theme.id === settings.fileIconTheme)
    ? settings.fileIconTheme!
    : BUILTIN_ICON_THEME_ID

  return (
    <Select value={selected} onValueChange={(value) => updateSettings({ fileIconTheme: value })}>
      <SelectTrigger size="sm" className="w-52" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={BUILTIN_ICON_THEME_ID}>
          {translate('settings.appearance.fileIconTheme.builtin', 'Orca Built-in')}
        </SelectItem>
        {themes.map((theme) => (
          <SelectItem key={theme.id} value={theme.id}>
            {theme.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
