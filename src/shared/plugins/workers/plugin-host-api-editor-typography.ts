import { z } from 'zod'
import type { GlobalSettings } from '../../global-settings-types'
import {
  resolveEditorTypography,
  resolveFileEditorMinimapEnabled,
  resolveFileEditorWordWrap
} from '../../editor/editor-typography'
import { ALL_SURFACES, spec } from './plugin-host-method-spec'

/** Provisional release floor for `editor.typography.changed`; not a stock-release claim. */
export const PLUGIN_EDITOR_TYPOGRAPHY_SINCE = '1.4.256'
const FONT_FAMILY_MAX = 8 * 1024

/** What `editor.readTypography` answers and `editor.typography.changed` carries. */
export const pluginEditorTypographySchema = z
  .object({
    /** The font family Orca gives its file editor, as configured (the terminal font when unset). */
    fontFamily: z.string().min(1).max(FONT_FAMILY_MAX),
    /** The same family as a full CSS `font-family` stack, with Orca's monospace fallbacks. */
    cssFontFamily: z.string().min(1).max(FONT_FAMILY_MAX),
    /** Pixels, with the editor zoom applied. */
    fontSize: z.number().finite().positive(),
    /** A CSS `font-weight`: `normal`, or `100` to `900`. */
    fontWeight: z.string().min(1).max(16),
    /** Pixels; 0 when Orca leaves line spacing automatic. */
    lineHeight: z.number().finite().nonnegative(),
    fontLigatures: z.boolean(),
    wordWrap: z.enum(['on', 'off']),
    minimap: z.boolean()
  })
  .strict()

export type PluginEditorTypography = z.infer<typeof pluginEditorTypographySchema>

/** The values Orca's own file editor resolves from these settings and its editor zoom. */
export function resolvePluginEditorTypography(
  settings: Partial<GlobalSettings> | null | undefined,
  editorFontZoomLevel: number | undefined
): PluginEditorTypography {
  // Why: a hand-edited profile can hold a non-number; the renderer treats a missing zoom as 0.
  const zoom =
    typeof editorFontZoomLevel === 'number' && Number.isFinite(editorFontZoomLevel)
      ? editorFontZoomLevel
      : 0
  const typography = resolveEditorTypography(settings, zoom, 'editor')
  return {
    // Why cut, not refuse: an unbounded setting must not make every read fail its schema.
    fontFamily: typography.fontFamily.slice(0, FONT_FAMILY_MAX),
    cssFontFamily: typography.cssFontFamily.slice(0, FONT_FAMILY_MAX),
    fontSize: typography.fontSize,
    fontWeight: typography.fontWeight,
    lineHeight: typography.lineHeight,
    fontLigatures: typography.fontLigatures,
    wordWrap: resolveFileEditorWordWrap(settings?.editorWordWrap),
    minimap: resolveFileEditorMinimapEnabled(settings)
  }
}

/** Read-only and non-sensitive, so no capability; spread into the host API table. */
export const PLUGIN_EDITOR_TYPOGRAPHY_API = {
  'editor.readTypography': spec({
    summary:
      "The font family, size, weight, line height, ligatures, word wrap and minimap Orca's file editor uses now, editor zoom included. `editor.typography.changed` reports each change after.",
    since: 6,
    scope: 'desktop',
    capability: null,
    mutation: false,
    surfaces: ALL_SURFACES,
    params: z.strictObject({}).optional(),
    result: pluginEditorTypographySchema
  })
}
