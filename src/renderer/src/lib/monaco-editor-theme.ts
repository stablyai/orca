import type * as Monaco from 'monaco-editor'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isPureBlackVariant } from '../../../shared/dark-appearance-variant'
import { useAppStore } from '../store'

type MonacoModule = typeof Monaco

export const PURE_BLACK_MONACO_THEME = 'orca-pure-black'

/**
 * Monaco owns its own palette, so the `.dark.pure-black` CSS tokens never reach
 * it — without this the editor stays a #1e1e1e rectangle inside a #000 app.
 * Inherits vs-dark so only the surfaces move; syntax colors are untouched.
 */
export function registerPureBlackMonacoTheme(monaco: MonacoModule): void {
  monaco.editor.defineTheme(PURE_BLACK_MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#000000',
      'editorGutter.background': '#000000',
      'editorStickyScroll.background': '#000000',
      'minimap.background': '#000000',
      'breadcrumb.background': '#000000',
      'editorGroupHeader.tabsBackground': '#000000',
      'editorPane.background': '#000000',
      // Floating chrome keeps a hairline lift: drop shadows do not read on #000.
      'editorWidget.background': '#0d0d0d',
      'editorWidget.border': '#2a2a2a',
      'editorSuggestWidget.background': '#0d0d0d',
      'editorSuggestWidget.border': '#2a2a2a',
      'editorHoverWidget.background': '#0d0d0d',
      'editorHoverWidget.border': '#2a2a2a',
      'peekViewEditor.background': '#000000',
      'peekViewResult.background': '#0d0d0d',
      'diffEditor.unchangedRegionBackground': '#000000'
    }
  })
}

export type MonacoDarkThemeName = 'vs-dark' | typeof PURE_BLACK_MONACO_THEME

export function resolveMonacoDarkThemeName(
  variant: GlobalSettings['darkAppearanceVariant']
): MonacoDarkThemeName {
  return isPureBlackVariant(variant) ? PURE_BLACK_MONACO_THEME : 'vs-dark'
}

/** Which dark Monaco theme every editor/diff/colorize surface should use. */
export function useMonacoDarkThemeName(): MonacoDarkThemeName {
  return resolveMonacoDarkThemeName(useAppStore((s) => s.settings?.darkAppearanceVariant))
}
