import { z } from 'zod'
import { tokenColorsSchema } from '../plugins/artifacts/plugin-theme-artifact'
import { THEME_STUDIO_MODES, themeStudioDraftSchema } from './theme-studio-draft'

/** Main → renderer: the draft to paint (null ends the preview). Coalesced to one per frame. */
export const THEME_STUDIO_PREVIEW_CHANNEL = 'themeStudio:preview'
/** Renderer → main (invoke): the draft to paint now, for a window that just loaded. */
export const THEME_STUDIO_CURRENT_CHANNEL = 'themeStudio:current'
/** Renderer → main: the contrast report for a painted revision. */
export const THEME_STUDIO_REPORT_CHANNEL = 'themeStudio:report'
export const THEME_STUDIO_REQUEST_CHANNEL = 'themeStudio:request'
export const THEME_STUDIO_REPLY_CHANNEL = 'themeStudio:reply'
/** Renderer → main: the user acted on the preview notice, or picked a theme in Settings. */
export const THEME_STUDIO_USER_ACTION_CHANNEL = 'themeStudio:userAction'

const modeSchema = z.enum(THEME_STUDIO_MODES)

export {
  themeStudioReportSchema,
  type ThemeStudioReport,
  type ThemeStudioModeReport
} from './theme-studio-findings'

const tokenSourceSchema = z.enum(['theme', 'derived', 'built-in'])
export type ThemeStudioTokenSource = z.infer<typeof tokenSourceSchema>

const resolvedModeSchema = z.object({
  mode: modeSchema,
  /** The app theme painted for this mode: a plugin theme id, Match Terminal, or null (built-in). */
  themeId: z.string().nullable(),
  themeLabel: z.string().nullable(),
  /** The plugin's name; a draft started from it keeps that name, so applying replaces it. */
  themeName: z.string().nullable().optional(),
  /** Every public token as painted, in hex; null when it could not be read. */
  tokens: z.record(
    z.string(),
    z.object({ value: z.string().nullable(), source: tokenSourceSchema })
  ),
  tokenColors: tokenColorsSchema.optional(),
  terminal: z.record(z.string(), z.string())
})
export type ThemeStudioResolvedMode = z.infer<typeof resolvedModeSchema>

const resolveResultSchema = z.object({
  shownMode: modeSchema,
  modes: z.array(resolvedModeSchema).max(2)
})
export type ThemeStudioResolveResult = z.infer<typeof resolveResultSchema>

export type ThemeStudioRequestBody =
  | { kind: 'resolve' }
  | { kind: 'select'; pluginKey: string }
  /** Puts back the settings a `select` replaced, for an undo right after saving. */
  | { kind: 'restore'; settings: Record<string, unknown> }
export type ThemeStudioRequest = ThemeStudioRequestBody & { requestId: string }

export const themeStudioReplySchema = z.discriminatedUnion('ok', [
  z.object({
    requestId: z.string(),
    ok: z.literal(true),
    resolved: resolveResultSchema.optional(),
    selected: z.boolean().optional(),
    /** The settings `select` replaced, so an undo can put them back. */
    previous: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({ requestId: z.string(), ok: z.literal(false), message: z.string().max(2048) })
])
export type ThemeStudioReply = z.infer<typeof themeStudioReplySchema>

export const themeStudioPreviewSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    draft: themeStudioDraftSchema,
    /** The change on screen, for the notice: its label, who made it and what was fixed with it. */
    last: z
      .object({
        label: z.string().max(256),
        by: z.string().max(256).optional(),
        autoFixed: z.number().int().nonnegative().optional()
      })
      .optional(),
    canUndo: z.boolean().optional()
  })
  .nullable()
export type ThemeStudioPreview = z.infer<typeof themeStudioPreviewSchema>

export const themeStudioUserActionSchema = z.object({
  /** `ended`: the user picked a theme in Settings, which ends the draft like Discard. */
  action: z.enum(['keep', 'undo', 'discard', 'ended']),
  revision: z.number().int().nonnegative()
})
export type ThemeStudioUserAction = z.infer<typeof themeStudioUserActionSchema>
