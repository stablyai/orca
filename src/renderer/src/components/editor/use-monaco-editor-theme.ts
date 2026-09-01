import { useLayoutEffect, useMemo } from 'react'
import { monaco } from '@/lib/monaco-setup'
import { ensureTerminalMonacoTheme } from './monaco-terminal-theme-registry'
import { useEditorSurfaceAppearance } from './use-editor-surface-appearance'

/** Monaco theme name for the current appearance; defines/re-applies the terminal-derived theme as it changes. */
export function useMonacoEditorTheme(): { isDark: boolean; theme: string } {
  const { isDark, palette } = useEditorSurfaceAppearance()
  const theme = useMemo(() => {
    if (!palette) {
      return isDark ? 'vs-dark' : 'vs'
    }
    // Why: define during render so a child <Editor> mounting before this hook's effects already finds
    // the theme registered.
    return ensureTerminalMonacoTheme(palette)
  }, [isDark, palette])
  useLayoutEffect(() => {
    // Why: Monaco's theme is global and @monaco-editor/react only re-applies on a name change, so a
    // redefined orca-terminal (terminal theme switched) needs an explicit setTheme; same-theme calls are no-ops.
    monaco.editor.setTheme(theme)
  }, [theme, palette])
  return { isDark, theme }
}
