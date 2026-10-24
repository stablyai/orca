import { SquareTerminal } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { usePluginIconThemes } from '@/store/plugin-icon-themes'
import { applyDocumentTheme, resolveDocumentTheme } from '@/lib/document-theme'
import { useAppStore } from '@/store'
import { usePluginThemes, usePluginTerminalThemes } from '@/store/plugin-themes'
import { Button } from '../../ui/button'
import { appThemeUpdate, terminalSlot, terminalThemeUpdate } from '../state/plugin-theme-apply'

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
  const use = (theme: (typeof themes)[number]): void => {
    void updateSettings(appThemeUpdate(settings, theme))
    applyDocumentTheme(theme.base)
  }
  const dark = resolveDocumentTheme(settings.theme)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs text-muted-foreground">
        {translate('auto.components.settings.PluginThemeUseNow.label', 'Use now:')}
      </span>
      {themes.map((theme) => (
        <Button
          key={theme.id}
          variant={settings.pluginAppTheme === theme.id ? 'secondary' : 'default'}
          size="xs"
          aria-pressed={settings.pluginAppTheme === theme.id}
          aria-label={translate(
            'auto.components.settings.PluginThemeUseNow.useName',
            'Use now: {{value0}}',
            { value0: theme.label }
          )}
          onClick={() => use(theme)}
        >
          {/* Why inline colour: the swatch is the theme's own palette. */}
          <span
            aria-hidden="true"
            className="flex size-3.5 overflow-hidden rounded-sm ring-1 ring-border"
          >
            <span className="flex-1" style={{ background: theme.tokens['--background'] }} />
            <span
              className="flex-1"
              style={{ background: theme.tokens['--primary'] ?? theme.tokens['--foreground'] }}
            />
          </span>
          {theme.label}
        </Button>
      ))}
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
        const slot = terminalSlot(theme.mode, dark)
        const selected =
          settings[slot] === theme.id &&
          (slot !== 'terminalThemeLight' || settings.terminalUseSeparateLightTheme)
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
    </div>
  )
}
