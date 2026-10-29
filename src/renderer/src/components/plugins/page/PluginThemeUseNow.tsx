import { SquareTerminal } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { usePluginIconThemes } from '@/store/plugin-icon-themes'
import { resolveDocumentTheme } from '@/lib/document-theme'
import { pluginAppThemeSlotUpdate } from '../../../../../shared/plugin-theme-settings'
import { useAppStore } from '@/store'
import { usePluginThemes, usePluginTerminalThemes } from '@/store/plugin-themes'
import { Button } from '../../ui/button'
import {
  isPluginAppThemeSelected,
  isPluginTerminalThemeSelected,
  terminalThemeUpdate
} from '../state/plugin-theme-apply'
import { PluginThemeSwatch } from './PluginThemeSwatch'

/** One-click "use it" for each theme a plugin adds, e.g. the other light/dark variant. */
export function PluginThemeUseNow({
  pluginKey,
  fallback = null
}: {
  pluginKey: string
  /** Shown instead when the plugin adds no theme. */
  fallback?: React.ReactNode
}): React.JSX.Element | null {
  const themes = usePluginThemes().filter((theme) => theme.pluginKey === pluginKey)
  const icons = usePluginIconThemes().filter((theme) => theme.pluginKey === pluginKey)
  const terminalThemes = usePluginTerminalThemes()
  const terminals = terminalThemes.filter((theme) => theme.pluginKey === pluginKey)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  if (themes.length + icons.length + terminals.length === 0 || !settings) {
    return <>{fallback}</>
  }
  const dark = resolveDocumentTheme(settings.theme)
  const mode = dark ? 'dark' : 'light'
  const prefixes = {
    now: translate('auto.components.settings.PluginThemeUseNow.label', 'Use now:'),
    light: translate('auto.components.settings.PluginThemeUseNow.useForLight', 'Use for light:'),
    dark: translate('auto.components.settings.PluginThemeUseNow.useForDark', 'Use for dark:')
  }
  const appChip = (theme: (typeof themes)[number]): React.JSX.Element => {
    const selected = isPluginAppThemeSelected(settings, theme)
    return (
      <Button
        key={theme.id}
        variant={selected ? 'secondary' : 'default'}
        size="xs"
        aria-pressed={selected}
        aria-label={`${theme.base === mode ? prefixes.now : prefixes[theme.base]} ${theme.label}`}
        onClick={() => void updateSettings(pluginAppThemeSlotUpdate(theme.base, theme.id))}
      >
        <PluginThemeSwatch theme={theme} />
        {theme.label}
      </Button>
    )
  }
  const otherMode = mode === 'dark' ? 'light' : 'dark'
  const later = themes.filter((theme) => theme.base === otherMode)
  const nowCount = themes.length - later.length + icons.length + terminals.length
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {nowCount > 0 ? (
        <span className="mr-1 text-xs text-muted-foreground">{prefixes.now}</span>
      ) : null}
      {themes.filter((theme) => theme.base === mode).map(appChip)}
      {icons.map((theme) => (
        <Button
          key={`icon:${theme.id}`}
          variant={settings.pluginIconTheme === theme.id ? 'secondary' : 'default'}
          size="xs"
          aria-pressed={settings.pluginIconTheme === theme.id}
          aria-label={translate(
            'auto.components.settings.PluginThemeUseNow.useName',
            'Use now: {{value0}}',
            { value0: theme.label }
          )}
          onClick={() => void updateSettings({ pluginIconTheme: theme.id })}
        >
          {theme.label}
        </Button>
      ))}
      {terminals.map((theme) => {
        const selected = isPluginTerminalThemeSelected(settings, theme, dark)
        return (
          <Button
            key={`terminal:${theme.id}`}
            variant={selected ? 'secondary' : 'default'}
            size="xs"
            aria-pressed={selected}
            aria-label={translate(
              'auto.components.settings.PluginThemeUseNow.useName',
              'Use now: {{value0}}',
              { value0: theme.label }
            )}
            onClick={() =>
              void updateSettings(terminalThemeUpdate(settings, theme, dark, terminalThemes))
            }
          >
            {/* Why an icon: a plugin's terminal themes often share their app themes' names. */}
            <SquareTerminal aria-hidden="true" />
            {theme.label}
          </Button>
        )
      })}
      {later.length > 0 ? (
        <span className="mx-1 text-xs text-muted-foreground">{prefixes[otherMode]}</span>
      ) : null}
      {later.map(appChip)}
    </div>
  )
}
