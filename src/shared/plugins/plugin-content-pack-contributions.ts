import { z } from 'zod'
import { pluginCommandIdSchema, pluginRelativePathSchema } from './plugin-manifest-fields'
import { normalizeKeybinding } from '../keybindings'
import {
  formatRoutePattern,
  normalizeRoutePattern,
  LINK_ROUTE_MAX_HOSTNAME_LENGTH
} from './plugin-link-route-matching'

export const PLUGIN_LANGUAGE_PACK_LIMIT = 16
export const PLUGIN_KEYBINDING_LIMIT = 256
export const PLUGIN_VM_RECIPE_LIMIT = 64
export const PLUGIN_AGENT_PROFILE_LIMIT = 64
export const PLUGIN_LINK_ROUTE_LIMIT = 64

// Why: locale ids become i18next bundle keys and filenames. This bounded BCP
// 47 subset covers current community packs without accepting path syntax.
export const pluginLocaleIdSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'must be a portable locale identifier')

export const pluginLanguagePackContributionSchema = z
  .object({
    locale: pluginLocaleIdSchema,
    path: pluginRelativePathSchema
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

// Why: the stored hostname is the canonical ascii form, so consent rendering and click-time matching
// compare the same string. A pattern that fails the shape rules is rejected here rather than
// silently never matching. The public-suffix half of the safety floor runs in main.
export const pluginLinkRouteContributionSchema = z
  .object({
    hostname: z
      .string()
      .min(1)
      .max(LINK_ROUTE_MAX_HOSTNAME_LENGTH + 2)
      .transform((value, ctx) => {
        const pattern = normalizeRoutePattern(value)
        if (!pattern) {
          ctx.addIssue({
            code: 'custom',
            message:
              'must be a hostname, optionally with one leading "*"; wildcards may not cover a public suffix'
          })
          return z.NEVER
        }
        return formatRoutePattern(pattern)
      }),
    destination: z.enum(['orca-browser', 'system-browser']),
    description: z.string().max(200).optional()
  })
  .strict()

export type PluginLanguagePackContribution = z.infer<typeof pluginLanguagePackContributionSchema>
export type PluginKeybindingContribution = z.infer<typeof pluginKeybindingContributionSchema>
export type PluginVmRecipeContribution = z.infer<typeof pluginVmRecipeContributionSchema>
export type PluginAgentProfileContribution = z.infer<typeof pluginAgentProfileContributionSchema>
