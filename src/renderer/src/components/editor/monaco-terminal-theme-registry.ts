import { monaco } from '@/lib/monaco-setup'
import {
  buildMonacoThemeData,
  TERMINAL_MONACO_THEME_NAME,
  type TerminalEditorPalette
} from '@/lib/terminal-editor-palette'

let definedThemeSignature: string | null = null

/**
 * Registers the terminal-derived Monaco theme for `palette` and returns its name. Monaco themes are
 * global, so the signature guard keeps repeated calls from every editor instance idempotent.
 */
export function ensureTerminalMonacoTheme(palette: TerminalEditorPalette): string {
  const themeData = buildMonacoThemeData(palette)
  const signature = JSON.stringify(themeData)
  if (signature !== definedThemeSignature) {
    monaco.editor.defineTheme(TERMINAL_MONACO_THEME_NAME, themeData)
    definedThemeSignature = signature
  }
  return TERMINAL_MONACO_THEME_NAME
}
