import { Check, SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { usePluginIconThemes } from '@/store/plugin-icon-themes'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { selectTerminalTheme } from '../../../../../shared/terminal-theme-selection'
import { pluginAppThemeSlotUpdate } from '../../../../../shared/plugin-theme-settings'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useAppStore } from '@/store'
import { usePluginThemes, usePluginTerminalThemes } from '@/store/plugin-themes'
import { Button } from '../../ui/button'
import {
  isPluginAppThemeSelected,
  isPluginTerminalThemeSelected,
  terminalThemeSlotUpdate,
  terminalThemeUpdate
} from '../state/plugin-theme-apply'
import { PluginThemeSwatch } from './PluginThemeSwatch'

type Chip = {
  key: string
  label: string
  showsNow: boolean
  selected: boolean
  icon: React.ReactNode
  update: () => Partial<GlobalSettings>
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
  const updateSettingsOrThrow = useAppStore((state) => state.updateSettingsOrThrow)
  const dark = useDocumentDarkTheme()
  if (themes.length + icons.length + terminals.length === 0 || !settings) {
    return <>{fallback}</>
  }
  const mode = dark ? 'dark' : 'light'
  const otherMode = dark ? 'light' : 'dark'
  const shownTerminal = selectTerminalTheme(settings, dark)
  const prefixes = {
    now: translate('auto.components.settings.PluginThemeUseNow.label', 'Use now:'),
    light: translate('auto.components.settings.PluginThemeUseNow.useForLight', 'Use for light:'),
    dark: translate('auto.components.settings.PluginThemeUseNow.useForDark', 'Use for dark:')
  }
  const chips: Chip[] = [
    ...themes.map((theme) => ({
      key: theme.id,
      label: theme.label,
      showsNow: theme.base === mode,
      selected: isPluginAppThemeSelected(settings, theme),
      icon: <PluginThemeSwatch theme={theme} />,
      update: () => pluginAppThemeSlotUpdate(theme.base, theme.id)
    })),
    ...icons.map((theme) => ({
      key: `icon:${theme.id}`,
      label: theme.label,
      showsNow: true,
      selected: settings.pluginIconTheme === theme.id,
      icon: null,
      update: () => ({ pluginIconTheme: theme.id })
    })),
    ...terminals.map((stored): Chip => {
      // Installation can place a theme in the displayed slot despite its declared mode.
      const theme =
        shownTerminal.themeName === stored.id
          ? {
              ...stored,
              mode: shownTerminal.useLightVariant ? ('light' as const) : ('dark' as const)
            }
          : stored
      const slots = terminalThemeSlotUpdate(theme, dark)
      return {
        key: `terminal:${theme.id}`,
        label: theme.label,
        showsNow: selectTerminalTheme({ ...settings, ...slots }, dark).themeName === theme.id,
        selected: isPluginTerminalThemeSelected(settings, theme, dark),
        // Why an icon: a plugin's terminal themes often share their app themes' names.
        icon: <SquareTerminal aria-hidden="true" />,
        update: () => terminalThemeUpdate(settings, theme, dark, terminalThemes)
      }
    })
  ]
  const choose = async (chip: Chip): Promise<void> => {
    try {
      const update = chip.update()
      await updateSettingsOrThrow(update)
      if (!chip.showsNow) {
        toast.success(
          otherMode === 'light'
            ? translate(
                'auto.components.settings.PluginThemeUseNow.assignedLight',
                '{{value0}} set as your light theme',
                { value0: chip.label }
              )
            : translate(
                'auto.components.settings.PluginThemeUseNow.assignedDark',
                '{{value0}} set as your dark theme',
                { value0: chip.label }
              )
        )
      }
    } catch {
      toast.error(
        translate(
          'auto.components.settings.PluginThemeUseNow.saveFailed',
          'Could not save the theme. Try again.'
        )
      )
    }
  }
  const renderChip = (chip: Chip): React.JSX.Element => (
    <Button
      key={chip.key}
      variant={chip.selected ? 'default' : 'outline'}
      size="xs"
      aria-pressed={chip.selected}
      aria-label={`${chip.showsNow ? prefixes.now : prefixes[otherMode]} ${chip.label}`}
      onClick={() => void choose(chip)}
    >
      {chip.icon}
      {chip.selected ? <Check aria-hidden="true" /> : null}
      {chip.label}
    </Button>
  )
  const now = chips.filter((chip) => chip.showsNow)
  const later = chips.filter((chip) => !chip.showsNow)
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
