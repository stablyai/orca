import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { pluginAppThemeSlotUpdate } from '../../../../shared/plugin-theme-settings'
import { Button } from '../ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { SettingsSegmentedControl } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { usePluginTerminalThemes, usePluginThemes } from '@/store/plugin-themes'
import { PluginThemeSwatch } from '../plugins/page/PluginThemeSwatch'
import {
  isPluginTerminalThemeSelected,
  terminalThemeUpdate
} from '../plugins/state/plugin-theme-apply'

type BuiltInTheme = GlobalSettings['theme']

const BUILT_IN = 'built-in'

/** System, Dark or Light; the Light theme and Dark theme slots pick the colors for each. */
export function AppearanceThemeControl({
  label,
  settings,
  updateSettings,
  applyTheme
}: {
  label: string
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  applyTheme: (theme: BuiltInTheme) => void
}): React.JSX.Element {
  return (
    <SettingsSegmentedControl
      ariaLabel={label}
      value={settings.theme}
      onChange={(theme) => {
        updateSettings({ theme })
        applyTheme(theme)
      }}
      options={[
        {
          value: 'system',
          label: translate('auto.components.settings.AppearancePane.fb0e0b4453', 'System')
        },
        {
          value: 'dark',
          label: translate('auto.components.settings.AppearancePane.7d26ccabe8', 'Dark')
        },
        {
          value: 'light',
          label: translate('auto.components.settings.AppearancePane.fd89b5487c', 'Light')
        }
      ]}
    />
  )
}

/** The app theme painted while Orca is in one mode: built-in or any enabled plugin theme of it. */
export function AppearanceThemeSlotSelect({
  base,
  label,
  settings,
  updateSettings
}: {
  base: 'light' | 'dark'
  label: string
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const themes = usePluginThemes().filter((theme) => theme.base === base)
  const pluginTerminalThemes = usePluginTerminalThemes()
  const selectedId = base === 'dark' ? settings.pluginAppThemeDark : settings.pluginAppThemeLight
  const active = themes.find((theme) => theme.id === selectedId)
  const groups = Map.groupBy(themes, (theme) => theme.pluginKey)
  const terminal = active
    ? pluginTerminalThemes.find(
        (theme) =>
          theme.pluginKey === active.pluginKey && (theme.mode === base || theme.mode === 'unknown')
      )
    : undefined
  const terminalInUse =
    terminal !== undefined && isPluginTerminalThemeSelected(settings, terminal, base === 'dark')
  return (
    <div className="flex flex-col items-end gap-1">
      <Select
        value={active?.id ?? BUILT_IN}
        onValueChange={(value) =>
          updateSettings(
            pluginAppThemeSlotUpdate(base, themes.find((theme) => theme.id === value)?.id ?? null)
          )
        }
      >
        <SelectTrigger size="sm" className="min-w-[220px]" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={BUILT_IN}>
            {translate(
              'auto.components.settings.AppearanceInterfaceSection.pluginIconTheme.builtIn',
              'Built-in'
            )}
          </SelectItem>
          {[...groups.values()].map((group) => (
            <SelectGroup key={group[0].pluginKey}>
              <SelectLabel>{group[0].pluginName}</SelectLabel>
              {group.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  <PluginThemeSwatch theme={theme} />
                  {theme.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {terminal && !terminalInUse ? (
        <Button
          variant="link"
          size="xs"
          onClick={() =>
            updateSettings(
              terminalThemeUpdate(settings, terminal, base === 'dark', pluginTerminalThemes)
            )
          }
        >
          {translate(
            'auto.components.settings.AppearanceThemeControl.useTerminalTheme',
            'Use its terminal colors'
          )}
        </Button>
      ) : null}
    </div>
  )
}
