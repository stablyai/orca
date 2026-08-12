import type * as Monaco from 'monaco-editor'
import { EDITOR_THEME_CATALOG, type EditorThemeCatalogId } from './catalog'
import { buildMonacoThemeFromPalette } from './palette'

export {
  EDITOR_THEME_CATALOG,
  type EditorThemeCatalogEntry,
  type EditorThemeCatalogId
} from './catalog'
export type { EditorThemePalette } from './palette'

/** The Monaco theme *names* our catalog IDs are registered under — same
 *  string, kept as a distinct export so call sites don't hardcode literals. */
export const EDITOR_THEME_IDS = Object.keys(EDITOR_THEME_CATALOG) as EditorThemeCatalogId[]

let registeredThemeIds: ReadonlySet<string> | null = null

/** Idempotent: safe to call on every editor mount, only defines each catalog
 *  theme with Monaco once per process. */
export function registerEditorThemeCatalog(monacoInstance: typeof Monaco): void {
  if (registeredThemeIds) {
    return
  }
  for (const [id, entry] of Object.entries(EDITOR_THEME_CATALOG)) {
    monacoInstance.editor.defineTheme(id, buildMonacoThemeFromPalette(entry.palette))
  }
  registeredThemeIds = new Set(Object.keys(EDITOR_THEME_CATALOG))
}
