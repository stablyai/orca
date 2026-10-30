import { Check, SquareTerminal } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { usePluginIconThemes } from '@/store/plugin-icon-themes'
import { resolveDocumentTheme } from '@/lib/document-theme'
import { pluginAppThemeSlotUpdate } from '../../../../../shared/plugin-theme-settings'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useAppStore } from '@/store'
import { usePluginThemes, usePluginTerminalThemes } from '@/store/plugin-themes'
import { Button } from '../../ui/button'
import {
  isPluginAppThemeSelected,
  isPluginTerminalThemeSelected,
  showThemeAppliedToast,
  terminalThemeSlot,
  terminalThemeUpdate,
  themeSettingsSnapshot
} from '../state/plugin-theme-apply'
import { PluginThemeSwatch } from './PluginThemeSwatch'

type Mode = 'light' | 'dark'

type Chip = {
  key: string
  label: string
  /** The app mode that shows this chip's theme. */
  mode: Mode
  selected: boolean
  icon: React.ReactNode
  update: Partial<GlobalSettings>
}

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
  const mode: Mode = dark ? 'dark' : 'light'
  const otherMode: Mode = dark ? 'light' : 'dark'
  const prefixes = {
    now: translate('auto.components.settings.PluginThemeUseNow.label', 'Use now:'),
    light: translate('auto.components.settings.PluginThemeUseNow.useForLight', 'Use for light:'),
    dark: translate('auto.components.settings.PluginThemeUseNow.useForDark', 'Use for dark:')
  }
  const chips: Chip[] = [
    ...themes.map((theme) => ({
      key: theme.id,
      label: theme.label,
      mode: theme.base,
      selected: isPluginAppThemeSelected(settings, theme),
      icon: <PluginThemeSwatch theme={theme} />,
      update: pluginAppThemeSlotUpdate(theme.base, theme.id)
    })),
    ...icons.map((theme) => ({
      key: `icon:${theme.id}`,
      label: theme.label,
      mode,
      selected: settings.pluginIconTheme === theme.id,
      icon: null,
      update: { pluginIconTheme: theme.id }
    })),
    ...terminals.map((stored): Chip => {
      // Why: light mode shows the dark slot unless it uses separate light themes.
      const shownSlot =
        dark || !settings.terminalUseSeparateLightTheme ? 'terminalThemeDark' : 'terminalThemeLight'
      // Why: a theme already on screen (e.g. a lone other-mode one an install put there) is "now".
      const shownNow = settings[shownSlot] === stored.id
      const theme = shownNow
        ? {
            ...stored,
            mode: shownSlot === 'terminalThemeDark' ? ('dark' as const) : ('light' as const)
          }
        : stored
      return {
        key: `terminal:${theme.id}`,
        label: theme.label,
        mode: shownNow
          ? mode
          : terminalThemeSlot(theme.mode, dark) === 'terminalThemeDark'
            ? 'dark'
            : 'light',
        selected: isPluginTerminalThemeSelected(settings, theme, dark),
        // Why an icon: a plugin's terminal themes often share their app themes' names.
        icon: <SquareTerminal aria-hidden="true" />,
        update: terminalThemeUpdate(settings, theme, dark, terminalThemes)
      }
    })
  ]
  const choose = (chip: Chip): void => {
    if (chip.mode === mode) {
      void updateSettings(chip.update)
      return
    }
    // Why switch modes: a theme for the other mode would otherwise change nothing on screen.
    const next: Partial<GlobalSettings> = { ...chip.update, theme: chip.mode }
    const snapshot: Readonly<Record<string, unknown>> = themeSettingsSnapshot(settings)
    // Why only these keys: Switch back must not undo picks made while the toast is still up.
    const previous: Partial<GlobalSettings> = Object.fromEntries(
      Object.keys(next).map((key) => [key, snapshot[key]])
    )
    void updateSettings(next)
    showThemeAppliedToast(chip.label, previous)
  }
  const renderChip = (chip: Chip): React.JSX.Element => (
    <Button
      key={chip.key}
      variant={chip.selected ? 'default' : 'outline'}
      size="xs"
      aria-pressed={chip.selected}
      aria-label={`${chip.mode === mode ? prefixes.now : prefixes[chip.mode]} ${chip.label}`}
      onClick={() => choose(chip)}
    >
      {chip.selected ? <Check aria-hidden="true" /> : chip.icon}
      {chip.label}
    </Button>
  )
  const now = chips.filter((chip) => chip.mode === mode)
  const later = chips.filter((chip) => chip.mode === otherMode)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {now.length > 0 ? (
        <span className="mr-1 text-xs text-muted-foreground">{prefixes.now}</span>
      ) : null}
      {now.map(renderChip)}
      {later.length > 0 ? (
        <span className="mx-1 text-xs text-muted-foreground">{prefixes[otherMode]}</span>
      ) : null}
      {later.map(renderChip)}
    </div>
  )
}
