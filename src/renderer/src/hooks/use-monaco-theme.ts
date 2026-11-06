import { useEffect, useState } from 'react'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { useCodeEditorThemeStore } from '@/store/code-editor-theme'

const definedThemes = new Set<string>()

/** The Monaco theme every editor surface uses: the editor or app theme's, else the built-in.
 *  `isDarkOverride` passes an already resolved app mode; a separate editor theme's base wins. */
export function useMonacoTheme(isDarkOverride?: boolean): string {
  const documentDark = useDocumentDarkTheme()
  const editorBase = useCodeEditorThemeStore((state) => state.override?.base)
  const isDark = editorBase ? editorBase === 'dark' : (isDarkOverride ?? documentDark)
  const pluginTheme = useCodeEditorThemeStore((state) => state.monaco)
  const [defined, setDefined] = useState(() => definedThemes)

  useEffect(() => {
    if (!pluginTheme || definedThemes.has(pluginTheme.name)) {
      return
    }
    let current = true
    // Why lazy: surfaces that never show an editor must not load Monaco for a theme.
    void import('monaco-editor').then((monaco) => {
      monaco.editor.defineTheme(pluginTheme.name, pluginTheme.data)
      definedThemes.add(pluginTheme.name)
      if (current) {
        setDefined(new Set(definedThemes))
      }
    })
    return () => {
      current = false
    }
  }, [pluginTheme])

  // Why the built-in until defined: Monaco silently ignores a theme name it doesn't know yet.
  return pluginTheme && defined.has(pluginTheme.name) ? pluginTheme.name : isDark ? 'vs-dark' : 'vs'
}
