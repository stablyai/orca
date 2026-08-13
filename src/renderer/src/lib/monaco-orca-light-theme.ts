import type { editor } from 'monaco-editor'
import { LIGHT_CONTENT_SURFACE_HEX } from './light-surface-tokens'

/** Monaco theme name registered in monaco-setup.ts and used at the editor call sites. */
export const ORCA_LIGHT_MONACO_THEME_NAME = 'orca-light'

// Why: derive from stock 'vs' with inherit:true and no custom token rules, so
// syntax highlighting is identical to Monaco's light theme. We only repaint the
// editor background family so the code area matches the app's cream content
// surface instead of stock white. Keep in sync with LIGHT_CONTENT_SURFACE_HEX.
export const orcaLightMonacoThemeData: editor.IStandaloneThemeData = {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': LIGHT_CONTENT_SURFACE_HEX,
    'editorGutter.background': LIGHT_CONTENT_SURFACE_HEX,
    'minimap.background': LIGHT_CONTENT_SURFACE_HEX
  }
}
