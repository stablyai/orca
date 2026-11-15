import { z } from 'zod'
import { THEME_STUDIO_MODES } from './theme-studio-draft'

const fixSchema = z.object({
  /** Which side moves: text and surface fixes change lightness only, keeping hue and chroma. */
  strategy: z.enum(['text-lightness', 'surface-lightness', 'border-alpha']),
  set: z.record(z.string(), z.string()),
  ratio: z.number().optional(),
  /** OKLab distance from the current color; about 0.02 is a just-noticeable step. */
  deltaE: z.number().optional()
})
export type ThemeStudioFix = z.infer<typeof fixSchema>

export const themeStudioFindingSchema = z.object({
  /** Stable for the same pair and mode across revisions; `orca theme check --fix --finding <id>`. */
  id: z.string().max(256),
  rule: z.enum(['text', 'status', 'ring', 'border', 'invalid']),
  /** The draft's own tokens the check leaves unpainted; Orca shows its built-in colors there. */
  tokens: z.array(z.string()).max(64),
  text: z.string().optional(),
  surface: z.string().optional(),
  /** Null when a side is translucent, which never passes. */
  ratio: z.number().nullable().optional(),
  min: z.number().optional(),
  /** What the user will see, in their terms. */
  effect: z.string().max(512),
  /** At most two, smallest change first. */
  fixes: z.array(fixSchema).max(2),
  command: z.string().max(512).optional()
})
export type ThemeStudioFinding = z.infer<typeof themeStudioFindingSchema>

export const themeStudioReportSchema = z.object({
  revision: z.number().int().nonnegative(),
  modes: z
    .array(
      z.object({
        mode: z.enum(THEME_STUDIO_MODES),
        /** Whether Orca shows this mode now; the other mode is checked without painting it. */
        shown: z.boolean(),
        findings: z.array(themeStudioFindingSchema).max(256)
      })
    )
    .max(2),
  /** What the window actually painted for this revision, read from the paint itself. */
  paint: z
    .object({
      mode: z.enum(THEME_STUDIO_MODES),
      dropped: z.array(z.string()).max(128),
      editor: z.enum(['follows-app', 'pinned'])
    })
    .optional()
})
export type ThemeStudioReport = z.infer<typeof themeStudioReportSchema>
export type ThemeStudioModeReport = ThemeStudioReport['modes'][number]
