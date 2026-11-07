import { useEffect, useState } from 'react'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { useCodeEditorThemeStore } from '@/store/code-editor-theme'

const definedThemes = new Set<string>()

type PluginMonacoTheme = NonNullable<ReturnType<typeof useCodeEditorThemeStore.getState>['monaco']>

// Why outside the hook: the React compiler cannot lower dynamic imports inside a hook.
async function definePluginMonacoTheme(theme: PluginMonacoTheme): Promise<void> {
  // Why lazy: surfaces that never show an editor must not load Monaco for a theme.
  const [monaco, data] = await Promise.all([
    import('monaco-editor'),
    import('@/lib/monaco-languages/markdown-monaco-theme-rules').then(
      ({ monacoThemeDataWithMarkdown }) => monacoThemeDataWithMarkdown(theme.data),
      // Why: markdown colors are extra; a failed chunk must not keep the theme undefined.
      () => theme.data
    )
  ])
  monaco.editor.defineTheme(theme.name, data)
  definedThemes.add(theme.name)
}

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
    void definePluginMonacoTheme(pluginTheme).then(() => {
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
