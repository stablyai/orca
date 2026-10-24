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
export const PLUGIN_ICON_THEME_LIMIT = 32
export const PLUGIN_SYNTAX_LIMIT = 16

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

/** App, terminal and icon themes share one shape: a labelled JSON artifact. */
export const pluginThemeContributionSchema = z
  .object({
    id: pluginIdSchema,
    label: z.string().min(1).max(128),
    path: pluginRelativePathSchema
  })
  .strict()

export const pluginGrammarScopeSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/, 'must be a TextMate scope name')

/** One highlighted language: the files it claims and its TextMate grammar. */
export const pluginSyntaxContributionSchema = z
  .object({
    id: pluginIdSchema,
    label: z.string().min(1).max(128),
    scopeName: pluginGrammarScopeSchema,
    path: pluginRelativePathSchema,
    configuration: pluginRelativePathSchema.optional(),
    extensions: z
      .array(
        z
          .string()
          .max(64)
          .regex(/^\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/, 'must look like .ext')
      )
      .max(32)
      .default([]),
    filenames: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .refine(
            (name) =>
              name !== '.' &&
              name !== '..' &&
              !/[<>:"/\\|?*]/.test(name) &&
              Array.from(name).every((character) => character.charCodeAt(0) >= 32),
            'must be a portable file name'
          )
      )
      .max(32)
      .default([])
  })
  .strict()

export type PluginLanguagePackContribution = z.infer<typeof pluginLanguagePackContributionSchema>
export type PluginKeybindingContribution = z.infer<typeof pluginKeybindingContributionSchema>
export type PluginVmRecipeContribution = z.infer<typeof pluginVmRecipeContributionSchema>
export type PluginAgentProfileContribution = z.infer<typeof pluginAgentProfileContributionSchema>
export type PluginThemeContribution = z.infer<typeof pluginThemeContributionSchema>
export type PluginSyntaxContribution = z.infer<typeof pluginSyntaxContributionSchema>
