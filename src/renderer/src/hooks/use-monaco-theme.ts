import { useEffect, useState } from 'react'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { useCodeEditorThemeStore } from '@/store/code-editor-theme'

const definedThemes = new Set<string>()

type PluginMonacoThemeData = NonNullable<
  ReturnType<typeof useCodeEditorThemeStore.getState>['monaco']
>['data']

// Why lazy: surfaces that never show an editor must not load Monaco for a theme. Module-level
// because React Compiler can't lower `import()` inside a hook.
function loadPluginMonacoTheme(data: PluginMonacoThemeData) {
  return Promise.all([
    import('monaco-editor'),
    import('@/lib/monaco-languages/markdown-monaco-theme-rules').then(
      ({ monacoThemeDataWithMarkdown }) => monacoThemeDataWithMarkdown(data),
      // Why: markdown colors are extra; a failed chunk must not keep the theme undefined.
      () => data
    )
  ])
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
    void loadPluginMonacoTheme(pluginTheme.data).then(([monaco, data]) => {
      monaco.editor.defineTheme(pluginTheme.name, data)
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
