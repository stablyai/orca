import { z } from 'zod'
import {
  pluginCommandIdSchema,
  pluginIdSchema,
  pluginRelativePathSchema
} from './plugin-manifest-fields'
import { normalizeKeybinding } from '../keybindings'

export const PLUGIN_LANGUAGE_PACK_LIMIT = 16
export const PLUGIN_KEYBINDING_LIMIT = 256
export const PLUGIN_VM_RECIPE_LIMIT = 64
export const PLUGIN_AGENT_PROFILE_LIMIT = 64
export const PLUGIN_THEME_LIMIT = 64
export const PLUGIN_TERMINAL_THEME_LIMIT = 64

/** True when Intl can parse the tag's grammar, not just its shape. */
function isWellFormedLocaleId(value: string): boolean {
  try {
    Intl.getCanonicalLocales(value)
    return true
  } catch {
    return false
  }
}

// Locale IDs become filenames/i18next keys; a bounded BCP 47 subset excludes path syntax.
// Intl rejects shape-valid, ill-formed tags (`en-US-US`) at install, not silently when formatting.
export const pluginLocaleIdSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'must be a portable locale identifier')
  .refine(isWellFormedLocaleId, 'must be a well-formed locale identifier')

export const pluginLanguagePackContributionSchema = z
  .object({
    locale: pluginLocaleIdSchema,
    path: pluginRelativePathSchema,
    // Native-language label for the Settings picker; omitted packs show `{locale} — {pluginKey}`.
    displayName: z.string().trim().min(1).max(80).optional()
  })
  .strict()

export const pluginKeybindingContributionSchema = z
  .object({
    command: pluginCommandIdSchema,
    key: z
      .string()
      .min(1)
      .max(128)
      .transform((value, ctx) => {
        const normalized = normalizeKeybinding(value)
        if (!normalized.ok) {
          ctx.addIssue({ code: 'custom', message: normalized.error })
          return z.NEVER
        }
        return normalized.value
      }),
    when: z.enum(['global', 'worktree']).optional()
  })
  .strict()

export const pluginVmRecipeContributionSchema = z
  .object({ path: pluginRelativePathSchema })
  .strict()

export const pluginAgentProfileContributionSchema = z
  .object({ path: pluginRelativePathSchema })
  .strict()

/** App and terminal themes share one shape: a labelled JSON artifact. */
export const pluginThemeContributionSchema = z
  .object({
    id: pluginIdSchema,
    label: z.string().min(1).max(128),
    path: pluginRelativePathSchema
  })
  .strict()

export type PluginLanguagePackContribution = z.infer<typeof pluginLanguagePackContributionSchema>
export type PluginKeybindingContribution = z.infer<typeof pluginKeybindingContributionSchema>
export type PluginVmRecipeContribution = z.infer<typeof pluginVmRecipeContributionSchema>
export type PluginAgentProfileContribution = z.infer<typeof pluginAgentProfileContributionSchema>
export type PluginThemeContribution = z.infer<typeof pluginThemeContributionSchema>
