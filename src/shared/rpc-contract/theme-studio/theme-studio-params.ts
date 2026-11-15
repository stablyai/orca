import { z } from 'zod'
import {
  THEME_STUDIO_MODES,
  themeStudioDraftSchema,
  themeStudioPatchSchema
} from '../../theme-studio/theme-studio-draft'
import { THEME_STUDIO_SEPARATE_SCOPE_NAMES } from '../../theme-studio/theme-studio-separate'

const modeSchema = z.enum(THEME_STUDIO_MODES)
const nameSchema = z.string().trim().min(1).max(64)
// Why a bound: a whole-theme transform past +-100% only clips colors to black, white or grey.
const percentSchema = z.number().min(-100).max(100)

/** Every change may name who asks and the revision it read; older CLIs send neither. */
const callerFields = {
  /** The caller's Orca terminal, so the notice and history can name the agent and pane. */
  terminal: z.string().min(1).max(256).optional(),
  /** Refuse with `draft_conflict` when the draft moved past this revision. */
  ifRevision: z.number().int().nonnegative().optional()
}

export const ThemeStudioStatusParams = z.object({
  resolved: z.boolean().optional(),
  /** False skips waiting for the open draft's contrast report. */
  report: z.boolean().optional()
})

export const ThemeStudioEditParams = z.object({
  from: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('current') }),
    /** An installed theme id, or a plugin key for all of its themes. */
    z.object({ kind: z.literal('installed'), target: z.string().min(1).max(256) }),
    /** Theme files the CLI read from a folder (data only). */
    z.object({ kind: z.literal('draft'), draft: themeStudioDraftSchema })
  ]),
  name: nameSchema.optional(),
  ...callerFields
})

export const ThemeStudioPatchParams = z.object({
  patch: themeStudioPatchSchema,
  label: z.string().max(256).optional(),
  ...callerFields
})

export const ThemeStudioAdjustParams = z.object({
  modes: z.array(modeSchema).min(1).max(2),
  adjustment: z.strictObject({
    warmth: percentSchema.optional(),
    hue: z.number().min(-360).max(360).optional(),
    saturation: percentSchema.optional(),
    lightness: percentSchema.optional(),
    contrast: percentSchema.optional()
  }),
  only: z.array(z.string().min(1).max(64)).max(64).optional(),
  /** Steps an area's surfaces this much OKLCH lightness away from the canvas. */
  separate: z
    .object({
      scope: z.enum(THEME_STUDIO_SEPARATE_SCOPE_NAMES),
      amount: z.number().min(-0.5).max(0.5)
    })
    .optional(),
  /** False leaves contrast issues for the caller instead of fixing them in the same step. */
  fix: z.boolean().optional(),
  ...callerFields
})

export const ThemeStudioCheckParams = z.object({
  fix: z.boolean().optional(),
  /** Fix only these findings, by the `id` a report gave. */
  findings: z.array(z.string().min(1).max(256)).max(64).optional(),
  ...callerFields
})

export const ThemeStudioStepParams = z.object({
  direction: z.enum(['undo', 'redo']),
  ...callerFields
})

export const ThemeStudioCallerParams = z.object(callerFields)

export const ThemeStudioShotParams = z.object({ mode: modeSchema.optional() })

export const ThemeStudioApplyParams = z.object({ name: nameSchema.optional(), ...callerFields })
