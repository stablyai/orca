import type { CSSProperties } from 'react'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { resolveLeftSidebarStyleVariables } from '@/lib/left-sidebar-appearance'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'

/** Scoped CSS vars that make app chrome (sidebars, tab strips, titlebars) follow the
 *  sidebar appearance setting; undefined in default mode. */
export function useChromeAppearanceStyle(): CSSProperties | undefined {
  // Why: pick only the fields the resolver reads so tab strips don't re-render on unrelated settings writes.
  const appearanceSettings = useAppStore(
    useShallow((s) =>
      s.settings
        ? {
            leftSidebarAppearanceMode: s.settings.leftSidebarAppearanceMode,
            leftSidebarTintColor: s.settings.leftSidebarTintColor,
            leftSidebarTintOpacity: s.settings.leftSidebarTintOpacity,
            theme: s.settings.theme,
            terminalThemeDark: s.settings.terminalThemeDark,
            terminalDividerColorDark: s.settings.terminalDividerColorDark,
            terminalUseSeparateLightTheme: s.settings.terminalUseSeparateLightTheme,
            terminalThemeLight: s.settings.terminalThemeLight,
            terminalCustomThemes: s.settings.terminalCustomThemes,
            terminalDividerColorLight: s.settings.terminalDividerColorLight,
            terminalColorOverrides: s.settings.terminalColorOverrides,
            terminalBackgroundOpacity: s.settings.terminalBackgroundOpacity
          }
        : null
    )
  )
  const systemPrefersDark = useSystemPrefersDark()
  return useMemo(
    () => resolveLeftSidebarStyleVariables(appearanceSettings, systemPrefersDark),
    [appearanceSettings, systemPrefersDark]
  )
}
