import { z } from 'zod'
import { THEME_STUDIO_MODES, themeStudioVariantSchema } from './theme-studio-draft'

/** What the hidden specimen page draws, passed in its URL hash as base64url JSON. */
export const themeStudioSpecimenRequestSchema = z.object({
  name: z.string().max(128),
  panels: z
    .array(
      z.object({
        mode: z.enum(THEME_STUDIO_MODES),
        variant: themeStudioVariantSchema.nullable(),
        /** The terminal theme the person uses in this mode; the draft's palette goes over it. */
        terminalBase: z.record(z.string(), z.string()).optional()
      })
    )
    .min(1)
    .max(2)
})
export type ThemeStudioSpecimenRequest = z.infer<typeof themeStudioSpecimenRequestSchema>

/** The page sets this title once both panels are painted, so the window knows when to capture. */
export const THEME_STUDIO_SPECIMEN_READY_TITLE = 'orca-theme-specimen-ready'
export const THEME_STUDIO_SPECIMEN_FAILED_TITLE = 'orca-theme-specimen-failed'
/** Query parameter naming the mode one panel document paints. */
export const THEME_STUDIO_SPECIMEN_PANEL = 'panel'
