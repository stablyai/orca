import { DEFAULT_TERMINAL_DIVIDER_DARK, DEFAULT_TERMINAL_DIVIDER_LIGHT } from '@/lib/terminal-theme'

/**
 * A divider color changed from its default also paints tab-group splits, above any theme token;
 * the default stays unset so the built-in 3:1 split color (or the theme's) shows.
 */
export function applySplitDividerSetting(color: string | undefined, dark: boolean): void {
  const style = document.documentElement.style
  const value = color?.trim().toLowerCase()
  const fallback = dark ? DEFAULT_TERMINAL_DIVIDER_DARK : DEFAULT_TERMINAL_DIVIDER_LIGHT
  if (value && value !== fallback && CSS.supports('color', value)) {
    style.setProperty('--split-divider-setting', value)
  } else {
    style.removeProperty('--split-divider-setting')
  }
}
