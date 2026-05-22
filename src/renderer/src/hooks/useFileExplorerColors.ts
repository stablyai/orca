import { useMemo } from 'react'
import {
  DEFAULT_FILE_EXPLORER_COLOR_THEME_DARK,
  DEFAULT_FILE_EXPLORER_COLOR_THEME_LIGHT,
  type FileExplorerColorMap,
  type FileExplorerColorOverrides,
  type FileExplorerColorTheme,
  getFileExplorerColorTheme,
  toColorMap
} from '@/lib/file-explorer-themes'
import { useAppStore } from '@/store'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'

/**
 * Resolves the active file explorer color theme by layering, in order:
 *
 *   1. The mode-specific built-in theme (from `fileExplorerColorThemeDark` or
 *      `fileExplorerColorThemeLight`, respecting
 *      `fileExplorerUseSeparateLightTheme`).
 *   2. The mode-specific override record from `GlobalSettings`.
 *
 * Per-row inline styles are avoided — see `useFileExplorerCssVars` which
 * writes the resolved map onto a ref'd ancestor as CSS variables so the row
 * stays render-cheap during virtualization.
 */
export function useFileExplorerColors(): {
  theme: FileExplorerColorTheme
  colors: FileExplorerColorMap
  mode: 'dark' | 'light'
} {
  const themePref = useAppStore((s) => s.settings?.theme)
  const systemDark = useSystemPrefersDark()
  const useSeparateLight = useAppStore((s) => s.settings?.fileExplorerUseSeparateLightTheme) ?? true
  const darkThemeId =
    useAppStore((s) => s.settings?.fileExplorerColorThemeDark) ??
    DEFAULT_FILE_EXPLORER_COLOR_THEME_DARK
  const lightThemeId =
    useAppStore((s) => s.settings?.fileExplorerColorThemeLight) ??
    DEFAULT_FILE_EXPLORER_COLOR_THEME_LIGHT
  const overridesDark = useAppStore((s) => s.settings?.fileExplorerColorOverridesDark) ?? null
  const overridesLight = useAppStore((s) => s.settings?.fileExplorerColorOverridesLight) ?? null

  const mode: 'dark' | 'light' =
    themePref === 'dark' ? 'dark' : themePref === 'light' ? 'light' : systemDark ? 'dark' : 'light'

  return useMemo(() => {
    const fallbackId =
      mode === 'dark'
        ? DEFAULT_FILE_EXPLORER_COLOR_THEME_DARK
        : DEFAULT_FILE_EXPLORER_COLOR_THEME_LIGHT
    const fallback = getFileExplorerColorTheme(fallbackId)!

    const effectiveId =
      mode === 'dark' ? darkThemeId : useSeparateLight ? lightThemeId : darkThemeId
    const baseTheme = getFileExplorerColorTheme(effectiveId) ?? fallback

    const overrides: FileExplorerColorOverrides | null =
      mode === 'dark' ? overridesDark : overridesLight

    const merged: FileExplorerColorMap = { ...toColorMap(baseTheme), ...overrides }

    return {
      theme: { ...baseTheme, ...merged },
      colors: merged,
      mode
    }
  }, [mode, darkThemeId, lightThemeId, useSeparateLight, overridesDark, overridesLight])
}
