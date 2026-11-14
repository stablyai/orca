import { z } from 'zod'
import { tokenColorsSchema } from '../plugins/artifacts/plugin-theme-artifact'
import {
  THEME_STUDIO_MODES,
  themeStudioDraftSchema,
  type ThemeStudioDraft
} from './theme-studio-draft'

/** Main → renderer: the draft to paint (null ends the preview). Coalesced to one per frame. */
export const THEME_STUDIO_PREVIEW_CHANNEL = 'themeStudio:preview'
/** Renderer → main (invoke): the draft to paint now, for a window that just loaded. */
export const THEME_STUDIO_CURRENT_CHANNEL = 'themeStudio:current'
/** Renderer → main: the contrast report for a painted revision. */
export const THEME_STUDIO_REPORT_CHANNEL = 'themeStudio:report'
export const THEME_STUDIO_REQUEST_CHANNEL = 'themeStudio:request'
export const THEME_STUDIO_REPLY_CHANNEL = 'themeStudio:reply'
/** Renderer → main: the user pressed Keep or Discard on the preview toast. */
export const THEME_STUDIO_USER_ACTION_CHANNEL = 'themeStudio:userAction'

export type ThemeStudioPreview = { revision: number; draft: ThemeStudioDraft } | null

const modeSchema = z.enum(THEME_STUDIO_MODES)

const themeStudioIssueSchema = z.object({
  problem: z.enum(['contrast', 'ring', 'border-alpha', 'invalid']),
  /** The theme tokens the check left unpainted; they show Orca's built-in colors instead. */
  tokens: z.array(z.string()).max(64),
  /** For contrast: the text and surface tokens that failed together. */
  text: z.string().optional(),
  surface: z.string().optional(),
  /** Null when a side is translucent, which never passes. */
  ratio: z.number().nullable().optional(),
  min: z.number().optional(),
  /** One value that passes this check; `orca theme check --fix` applies it. */
  fix: z.object({ token: z.string(), value: z.string(), ratio: z.number().optional() }).optional()
})
export type ThemeStudioIssue = z.infer<typeof themeStudioIssueSchema>

export const themeStudioReportSchema = z.object({
  revision: z.number().int().nonnegative(),
  modes: z
    .array(
      z.object({
        mode: modeSchema,
        /** Whether Orca shows this mode now; the other mode is checked without painting it. */
        shown: z.boolean(),
        issues: z.array(themeStudioIssueSchema).max(256)
      })
    )
    .max(2)
})
export type ThemeStudioReport = z.infer<typeof themeStudioReportSchema>
export type ThemeStudioModeReport = ThemeStudioReport['modes'][number]

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

export type ThemeStudioRequestBody = { kind: 'resolve' } | { kind: 'select'; pluginKey: string }
export type ThemeStudioRequest = ThemeStudioRequestBody & { requestId: string }

export const themeStudioReplySchema = z.discriminatedUnion('ok', [
  z.object({
    requestId: z.string(),
    ok: z.literal(true),
    resolved: resolveResultSchema.optional(),
    selected: z.boolean().optional()
  }),
  z.object({ requestId: z.string(), ok: z.literal(false), message: z.string().max(2048) })
])
export type ThemeStudioReply = z.infer<typeof themeStudioReplySchema>

export const themeStudioPreviewSchema = z
  .object({ revision: z.number().int().nonnegative(), draft: themeStudioDraftSchema })
  .nullable()

export const themeStudioUserActionSchema = z.object({
  action: z.enum(['keep', 'discard']),
  revision: z.number().int().nonnegative()
})
export type ThemeStudioUserAction = z.infer<typeof themeStudioUserActionSchema>
