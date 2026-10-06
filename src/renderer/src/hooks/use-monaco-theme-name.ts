import { useMemo, useSyncExternalStore } from 'react'
import * as monaco from 'monaco-editor'
import { getOmarchyThemePalette, subscribeOmarchyThemePalette } from '@/lib/omarchy-theme-state'
import { deriveOmarchyMonacoColors } from '../../../shared/omarchy-theme-palette'

export const OMARCHY_MONACO_THEME = 'orca-omarchy'

/** Monaco theme for the current app appearance; Monaco themes are global, so every editor must agree. */
export function useMonacoThemeName(isDark: boolean): string {
  const palette = useSyncExternalStore(subscribeOmarchyThemePalette, getOmarchyThemePalette)
  return useMemo(() => {
    if (!palette) {
      return isDark ? 'vs-dark' : 'vs'
    }
    // Redefining the active theme makes Monaco repaint every editor with the new colors.
    monaco.editor.defineTheme(OMARCHY_MONACO_THEME, {
      base: palette.seed.mode === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [],
      colors: deriveOmarchyMonacoColors(palette.seed)
    })
    return OMARCHY_MONACO_THEME
  }, [isDark, palette])
}
