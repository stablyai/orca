import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { DEFAULT_TERMINAL_DIVIDER_DARK, DEFAULT_TERMINAL_DIVIDER_LIGHT } from '@/lib/terminal-theme'
import { selectTerminalTheme } from '../../../shared/terminal-theme-selection'

/**
 * A divider color changed from its default also paints tab-group splits, above any theme token;
 * the default stays unset so the built-in 3:1 split color (or the theme's) shows.
 */
export function useSplitDividerSetting(): void {
  const systemPrefersDark = useSystemPrefersDark()
  // Why the terminal's variant, not the app mode: it is the one field Settings shows, and the one panes paint.
  const light = useAppStore((s) =>
    s.settings ? selectTerminalTheme(s.settings, systemPrefersDark).useLightVariant : false
  )
  const color = useAppStore((s) =>
    light ? s.settings?.terminalDividerColorLight : s.settings?.terminalDividerColorDark
  )
  useEffect(() => {
    const style = document.documentElement.style
    const value = color?.trim()
    const fallback = light ? DEFAULT_TERMINAL_DIVIDER_LIGHT : DEFAULT_TERMINAL_DIVIDER_DARK
    if (value && value.toLowerCase() !== fallback && CSS.supports('color', value)) {
      style.setProperty('--split-divider-setting', value)
    } else {
      style.removeProperty('--split-divider-setting')
    }
  }, [color, light])
}
